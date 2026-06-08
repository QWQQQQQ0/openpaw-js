// 来源: lib/services/chat_service.dart

import { getModelService } from '@/services/model-service-singleton';
import { ChatAgent } from '@/agents/chat-api';
import type { LLMMessage, ChatMessage, MessageContent, ToolCall, ToolCallResult } from '@/types/message';
import { serializeContent, deserializeContent } from '@/utils/content';
import { getDB } from '@/db';

export interface ChatStateUpdate {
  messages?: ChatMessage[];
  debugMessages?: ChatMessage[];
  isStreaming?: boolean;
  error?: string;
  logEntries?: Array<{ text: string }>;
}

export { ToolMode } from '@/stores/chat-store';

interface SendMessageParams {
  conversationId: string;
  messages: ChatMessage[];
  provider: {
    id: string;
    name: string;
    type: string;
    baseUrl: string;
    model: string;
    encryptedApiKey: string;
    supportsTools?: boolean;
    thinkingMode?: boolean;
    supportsMultimodal?: boolean;
  };
  tools?: Record<string, unknown>[];
}

type ToolExecutor = (toolName: string, params: Record<string, unknown>) => Promise<{
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}>;

let _skillExecutor: ToolExecutor | null = null;

export function setSkillExecutor(executor: ToolExecutor | null) {
  _skillExecutor = executor;
}

// Build LLMMessages from ChatMessages for sending to the model
function buildInternal(source: ChatMessage[]): LLMMessage[] {
  const result: LLMMessage[] = [];
  for (const m of source) {
    if ((m.role as string) === 'tool_call') continue;
    if (m.role === 'tool') {
      result.push({ role: 'tool', toolCallId: m.id, content: m.content });
    } else if (m.role === 'assistant') {
      const hasContent = typeof m.content === 'string' ? m.content.length > 0 : true;
      if (!hasContent && !m.toolCalls) continue;
      const llmMsg: LLMMessage = { role: 'assistant', content: m.content, toolCalls: m.toolCalls };
      // MiMo 等思考模型：回传 reasoning_content 避免多轮工具调用 400 错误
      if (m.reasoning_content) llmMsg.reasoning_content = m.reasoning_content;
      result.push(llmMsg);
    } else {
      result.push({ role: m.role, content: m.content });
    }
  }
  return result;
}

// Filter only user + assistant messages for visible display
function buildVisible(source: ChatMessage[]): ChatMessage[] {
  return source.filter((m) => m.role === 'user' || m.role === 'assistant');
}

export async function* sendChatMessage(params: SendMessageParams): AsyncGenerator<ChatStateUpdate> {
  const { conversationId, messages, provider, tools } = params;
  const modelService = getModelService();

  const visibleMessages = [...messages];
  const internalMessages: ChatMessage[] = [...messages];
  const debugMessages: ChatMessage[] = [];

  // Initial state
  yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: true };

  // Up to 5 turns of tool calling
  for (let turn = 0; turn < 5; turn++) {
    const assistantMsgId = crypto.randomUUID();
    const assistantMsg: ChatMessage = {
      id: assistantMsgId,
      conversationId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
      status: 'streaming',
    };
    visibleMessages.push(assistantMsg);
    internalMessages.push(assistantMsg);

    const llmMessages = buildInternal(internalMessages);
    let textBuffer = '';
    let toolCallJson: string | undefined;
    let reasoningBuffer = '';

    try {
      const chatAgent = new ChatAgent();
      const stream = chatAgent.chat({
        messages: llmMessages,
        provider: {
          id: provider.id,
          name: provider.name,
          type: provider.type as 'openai' | 'anthropic' | 'google',
          baseUrl: provider.baseUrl,
          model: provider.model,
          encryptedApiKey: provider.encryptedApiKey,
          isDefault: false,
          supportsTools: provider.supportsTools ?? true,
          thinkingMode: provider.thinkingMode,
          createdAt: '',
        },
        apiKey: provider.encryptedApiKey,
        tools,
      });

      for await (const chunk of stream) {
        if (chunk.startsWith('__ERROR__:')) {
          const errMsg = chunk.substring(10);
          visibleMessages[visibleMessages.length - 1] = {
            ...assistantMsg, content: errMsg, status: 'error',
          };
          yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: false, error: errMsg };
          return;
        } else if (chunk.startsWith('__REASONING__:')) {
          reasoningBuffer = chunk.substring(14);
        } else if (chunk.startsWith('__TOOLS__:')) {
          toolCallJson = chunk.substring(10);
        } else {
          textBuffer += chunk;
          visibleMessages[visibleMessages.length - 1] = {
            ...assistantMsg, content: textBuffer, reasoning_content: reasoningBuffer || undefined,
          };
          internalMessages[internalMessages.length - 1] = {
            ...assistantMsg, content: textBuffer, reasoning_content: reasoningBuffer || undefined,
          };
          yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: true };
        }
      }
    } catch (e) {
      visibleMessages[visibleMessages.length - 1] = {
        ...assistantMsg,
        content: textBuffer ? textBuffer : `Error: ${e}`,
        status: 'error',
      };
      yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: false, error: String(e) };
      return;
    }

    const rawResponse = textBuffer;

    // ── Handle tool calls ──
    if (toolCallJson && _skillExecutor) {
      try {
        const toolCalls = JSON.parse(toolCallJson) as Array<Record<string, unknown>>;
        console.log(`[chat-service] ◀ tool calls received: ${toolCalls.length} call(s)`, toolCalls.map(tc => {
          const fn = tc['function'] as Record<string, unknown>;
          return fn['name'];
        }));

        // Update assistant message with tool_calls
        const rc = reasoningBuffer || undefined;
        if (rawResponse.length > 0) {
          visibleMessages[visibleMessages.length - 1] = {
            ...assistantMsg, content: rawResponse, status: 'done',
            toolCalls: toolCalls as unknown as ToolCall[], reasoning_content: rc,
          };
          internalMessages[internalMessages.length - 1] = {
            ...assistantMsg, content: rawResponse, status: 'done',
            toolCalls: toolCalls as unknown as ToolCall[], reasoning_content: rc,
          };
        } else {
          visibleMessages.pop();
          internalMessages[internalMessages.length - 1] = {
            ...assistantMsg, content: '', status: 'done',
            toolCalls: toolCalls as unknown as ToolCall[], reasoning_content: rc,
          };
        }

        for (const tc of toolCalls) {
          const tcId = tc['id'] as string;
          const func = tc['function'] as Record<string, unknown>;
          const funcName = func['name'] as string;
          const funcArgs = func['arguments'] as string;

          let args: Record<string, unknown>;
          try {
            args = JSON.parse(funcArgs);
          } catch {
            args = {};
          }

          debugMessages.push({
            id: crypto.randomUUID(),
            conversationId,
            role: 'tool_call' as ChatMessage['role'],
            content: JSON.stringify({ function: funcName, arguments: args }),
            timestamp: new Date().toISOString(),
            status: 'done',
          });

          console.log(`[chat-service] ▶ executing tool: ${funcName}`, args);
          const result = await _skillExecutor(funcName, args);
          console.log(`[chat-service] ✓ tool result: ${funcName}`, result.success ? 'success' : 'failed', result.message?.substring(0, 120));

          debugMessages.push({
            id: tcId,
            conversationId,
            role: 'tool',
            content: JSON.stringify(result),
            timestamp: new Date().toISOString(),
            status: 'done',
          });

          internalMessages.push({
            id: tcId,
            conversationId,
            role: 'tool',
            content: JSON.stringify(result),
            timestamp: new Date().toISOString(),
            status: 'done',
          });
        }

        yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: true };
        continue; // Next turn
      } catch (e) {
        console.error(`[chat-service] ✗ tool execution error:`, e);
        debugMessages.push({
          id: crypto.randomUUID(),
          conversationId,
          role: 'tool_call' as ChatMessage['role'],
          content: `Tool error: ${e}`,
          timestamp: new Date().toISOString(),
          status: 'error',
        });
      }
    }

    // ── No tool calls → conversation turn complete ──
    const db = await getDB();
    if (rawResponse.length > 0) {
      const rc = reasoningBuffer || undefined;
      visibleMessages[visibleMessages.length - 1] = {
        ...assistantMsg, content: rawResponse, status: 'done', reasoning_content: rc,
      };
      internalMessages[internalMessages.length - 1] = {
        ...assistantMsg, content: rawResponse, status: 'done', reasoning_content: rc,
      };
      await db.execute(
        'INSERT INTO messages (id, conversation_id, role, content, timestamp, reasoning_content) VALUES (?, ?, ?, ?, ?, ?)',
        [assistantMsgId, conversationId, 'assistant', rawResponse, new Date().toISOString(), rc ?? null]
      );
    } else {
      visibleMessages.pop();
      internalMessages.pop();
    }

    yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: false };
    return;
  }

  // Exceeded max turns
  yield { messages: buildVisible(visibleMessages), debugMessages: [...debugMessages], isStreaming: false, error: 'Max iterations reached' };
}
