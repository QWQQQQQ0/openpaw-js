// 来源: lib/providers/chat_provider.dart

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { ChatMessage, MessageContent } from '@/types/message';
import type { ConversationRow } from '@/db';
import { getDB } from '@/db';
import { serializeContent, deserializeContent, hasImages } from '@/utils/content';
import { resolveMultimodalProvider } from '@/utils/multimodal-provider';
import { useModelConfigStore } from './model-config-store';
import { useSettingsStore } from './settings-store';
import { setSkillExecutor } from '@/services/chat-service';

export enum ToolMode {
  all = 'all',
  none = 'none',
  favorites = 'favorites',
  custom = 'custom',
}

export interface Conversation {
  id: string;
  title: string;
  modelProviderId: string;
  createdAt: string;
  updatedAt: string;
}

function rowToConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    modelProviderId: row.model_provider_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface ChatState {
  activeConversation: Conversation | null;
  conversations: Conversation[];
  messages: ChatMessage[];
  debugMessages: ChatMessage[];
  isStreaming: boolean;
  error: string | null;
  toolMode: ToolMode;
  customTools: Set<string>;

  // Actions — basic
  loadConversations: () => Promise<void>;
  createConversation: (modelProviderId: string, title: string) => Promise<Conversation>;
  loadMessages: (conversationId: string) => Promise<void>;
  deleteConversation: (id: string) => Promise<void>;
  newChat: () => void;
  switchConversation: (conv: Conversation) => Promise<void>;
  setToolMode: (mode: ToolMode) => void;
  setCustomTools: (tools: Set<string>) => void;
  toggleCustomTool: (toolName: string) => void;
  clearError: () => void;

  // Actions — streaming
  sendMessage: (content: MessageContent, password: string) => Promise<void>;
}

export const useChatStore = create<ChatState>()(
  immer((set, get) => ({
    activeConversation: null,
    conversations: [],
    messages: [],
    debugMessages: [],
    isStreaming: false,
    error: null,
    toolMode: ToolMode.all,
    customTools: new Set(),

    loadConversations: async () => {
      const db = await getDB();
      const rows = await db.query<ConversationRow>(
        'SELECT * FROM conversations ORDER BY updated_at DESC'
      );
      set({ conversations: rows.map(rowToConversation) });
    },

    createConversation: async (modelProviderId, title) => {
      const db = await getDB();
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      await db.execute(
        `INSERT INTO conversations (id, title, model_provider_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [id, title, modelProviderId, now, now]
      );
      const conv: Conversation = { id, title, modelProviderId, createdAt: now, updatedAt: now };
      set((s) => { s.conversations.unshift(conv); });
      return conv;
    },

    loadMessages: async (conversationId) => {
      const db = await getDB();
      const rows = await db.query<{ id: string; conversation_id: string; role: string; content: string; timestamp: string; reasoning_content: string | null }>(
        'SELECT * FROM messages WHERE conversation_id = ? ORDER BY timestamp ASC',
        [conversationId]
      );
      const messages = rows.map((r) => ({
        id: r.id,
        conversationId: r.conversation_id,
        role: r.role as ChatMessage['role'],
        content: deserializeContent(r.content),
        timestamp: r.timestamp,
        status: 'done' as const,
        reasoning_content: r.reasoning_content || undefined,
      }));
      set({ messages });
    },

    deleteConversation: async (id) => {
      const db = await getDB();
      await db.execute('DELETE FROM messages WHERE conversation_id = ?', [id]);
      await db.execute('DELETE FROM conversations WHERE id = ?', [id]);
      if (get().activeConversation?.id === id) {
        set({ activeConversation: null, messages: [], debugMessages: [] });
      }
      await get().loadConversations();
    },

    newChat: () => {
      set({ activeConversation: null, messages: [], debugMessages: [], error: null });
    },

    switchConversation: async (conv) => {
      set({ activeConversation: conv, error: null });
      await get().loadMessages(conv.id);
    },

    setToolMode: (mode) => set({ toolMode: mode }),
    setCustomTools: (tools) => set({ toolMode: ToolMode.custom, customTools: tools }),
    toggleCustomTool: (toolName) => set((state) => {
      const next = new Set(state.customTools);
      if (next.has(toolName)) next.delete(toolName);
      else next.add(toolName);
      return { customTools: next };
    }),
    clearError: () => set({ error: null }),

    sendMessage: async (content, password) => {
      const state = get();
      if (state.isStreaming) return;

      // Dynamically import ChatService to avoid circular deps
      const { sendChatMessage } = await import('@/services/chat-service');

      set({ isStreaming: true, error: null, debugMessages: [] });

      try {
        const modelStore = useModelConfigStore.getState();
        const settingsStore = useSettingsStore.getState();

        let provider = modelStore.defaultConfig();
        if (!provider) {
          set({ error: 'No model configured. Please add a model provider first.', isStreaming: false });
          return;
        }

        // 多模态自动切换：如果消息包含图片但当前模型不支持多模态，自动切换
        if (hasImages(content) && provider.supportsMultimodal === false) {
          const { provider: resolved, switched } = resolveMultimodalProvider(provider, modelStore.providers, content);
          if (switched) provider = resolved;
        }

        const apiKey = await modelStore.getApiKey(provider.id, password);

        // Get or create conversation
        let conversationId: string;
        let currentConv = state.activeConversation;

        if (!currentConv) {
          const text = typeof content === 'string' ? content : content
            .filter(p => p.type === 'text')
            .map(p => p.type === 'text' ? p.text : '')
            .join(' ');
          const title = text.length > 50 ? text.substring(0, 50) + '...' : text;
          currentConv = await get().createConversation(provider.id, title);
          set({ activeConversation: currentConv });
        }
        conversationId = currentConv.id;

        // Save user message to DB
        const db = await getDB();
        const userMsgId = crypto.randomUUID();
        const serContent = serializeContent(content);
        await db.execute(
          'INSERT INTO messages (id, conversation_id, role, content, timestamp) VALUES (?, ?, ?, ?, ?)',
          [userMsgId, conversationId, 'user', serContent, new Date().toISOString()]
        );
        await db.execute(
          'UPDATE conversations SET updated_at = ? WHERE id = ?',
          [new Date().toISOString(), conversationId]
        );

        // Load existing messages
        await get().loadMessages(conversationId);

        // Load skills from DB first (DB is the single source of truth)
        const { useSkillStore } = await import('@/stores/skill-store');
        const skillStore = useSkillStore.getState();
        await skillStore.initializeSkills();

        // Build SkillExecutor with DB configs for built-in skills
        const { initBuiltinExecutor, setCodeToolsModelService } = await import('@/skills/builtin-executor');
        const dbConfigs = skillStore.allConfigs.filter((c) => c.builtin);
        const executor = await initBuiltinExecutor(dbConfigs);
        executor.disabledTools = settingsStore.disabledTools;

        // Configure CodeToolsSkill with ModelService for unified LLM access
        const { getModelService } = await import('@/services/model-service-singleton');
        setCodeToolsModelService(getModelService(), provider, apiKey);

        // Register user-defined skills from DB (skip skills not exposed to AI)
        for (const skill of skillStore.getUserSkillInstances()) {
          if (skill.config.exposedToAI === false) continue;
          skill.setExecutor(executor);
          executor.register(skill);
        }

        // Wire executor into chat service for tool calling
        const toolExecutor = async (toolName: string, params: Record<string, unknown>) => {
          return executor.executeToolCall(toolName, params);
        };
        setSkillExecutor(toolExecutor);

        // Resolve tools based on tool mode
        const resolvedTools = state.toolMode === ToolMode.none ? undefined
          : state.toolMode === ToolMode.favorites && settingsStore.favoriteTools.size > 0
            ? executor.buildToolsForLLM(settingsStore.favoriteTools)
          : state.toolMode === ToolMode.custom
            ? executor.buildToolsForLLM(state.customTools)
          : executor.buildToolsForLLM();

        // Send message via chat service
        const generator = sendChatMessage({
          conversationId,
          messages: get().messages,
          provider: { ...provider, encryptedApiKey: apiKey },
          tools: resolvedTools,
        });

        for await (const update of generator) {
          set((s) => {
            if (update.messages) s.messages = update.messages;
            if (update.debugMessages) s.debugMessages = update.debugMessages;
            if (update.isStreaming !== undefined) s.isStreaming = update.isStreaming;
            if (update.error) s.error = update.error;
          });
        }
      } catch (e) {
        set({ error: String(e), isStreaming: false });
      }
    },
  }))
);
