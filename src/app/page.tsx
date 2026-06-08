// 来源: lib/screens/chat_screen.dart

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Menu, Terminal, Bug, MessageSquarePlus, Trash2, Plus, MessageCircle } from 'lucide-react';
import { useChatStore, ToolMode } from '@/stores/chat-store';
import { useT, formatRelativeTime } from '@/i18n/strings';
import { ChatBubble } from '@/components/chat/chat-bubble';
import { MessageInput } from '@/components/chat/message-input';
import { ModelSwitcher } from '@/components/chat/model-switcher';
import { ToolModeBar } from '@/components/chat/tool-mode-bar';
import type { MessageContent } from '@/types/message';

function ConversationsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const {
    conversations,
    activeConversation,
    loadConversations,
    switchConversation,
    deleteConversation,
    newChat,
  } = useChatStore();
  const t = useT();

  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" onClick={onClose} />
      <div className="fixed left-0 top-0 bottom-0 z-50 w-72 bg-white dark:bg-zinc-950 border-r border-zinc-200 dark:border-zinc-800 flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-800">
          <span className="font-semibold text-[15px] text-zinc-900 dark:text-zinc-100">
            {t('chat.conversations')}
          </span>
          <button
            onClick={onClose}
            className="p-1 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            ✕
          </button>
        </div>

        {/* New Chat button */}
        <button
          onClick={() => {
            newChat();
            onClose();
          }}
          className="flex items-center gap-3 px-4 py-3 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-950 text-[14px] font-medium"
        >
          <MessageSquarePlus size={18} />
          {t('chat.newchat')}
        </button>
        <div className="border-t border-zinc-100 dark:border-zinc-800" />

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-zinc-400 dark:text-zinc-500">
              <MessageCircle size={40} className="mb-3 opacity-40" />
              <p className="text-[13px] text-center">{t('chat.conversations.empty')}</p>
            </div>
          ) : (
            conversations.map((conv) => {
              const isActive = conv.id === activeConversation?.id;
              return (
                <div
                  key={conv.id}
                  className={`group flex items-center px-4 py-2.5 cursor-pointer transition-colors ${
                    isActive
                      ? 'bg-blue-50 dark:bg-blue-950'
                      : 'hover:bg-zinc-50 dark:hover:bg-zinc-900'
                  }`}
                >
                  <div
                    className="flex-1 min-w-0"
                    onClick={async () => {
                      if (!isActive) {
                        await switchConversation(conv);
                      }
                      onClose();
                    }}
                  >
                    <div
                      className={`text-[13px] truncate ${
                        isActive
                          ? 'font-semibold text-blue-700 dark:text-blue-300'
                          : 'text-zinc-800 dark:text-zinc-200'
                      }`}
                    >
                      {conv.title}
                    </div>
                    <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-0.5">
                      {formatRelativeTime(conv.updatedAt)}
                    </div>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(t('chat.delete.confirm', { title: conv.title }))) {
                        deleteConversation(conv.id);
                      }
                    }}
                    className="p-1 text-zinc-300 dark:text-zinc-600 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-all"
                    title={t('common.delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })
          )}
        </div>

        {/* Footer links */}
        <div className="border-t border-zinc-100 dark:border-zinc-800">
          <a
            href="/models"
            className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <Plus size={16} />
            {t('nav.models')}
          </a>
          <a
            href="/settings"
            className="flex items-center gap-3 px-4 py-2.5 text-[13px] text-zinc-600 dark:text-zinc-400 hover:bg-zinc-50 dark:hover:bg-zinc-900"
          >
            <Plus size={16} />
            {t('nav.settings')}
          </a>
        </div>
      </div>
    </>
  );
}

function DebugPanel({
  messages,
  open,
}: {
  messages: ReturnType<typeof useChatStore.getState>['debugMessages'];
  open: boolean;
}) {
  const t = useT();

  if (!open || messages.length === 0) return null;

  return (
    <div className="border-t border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-900/50">
      <div className="px-3 py-1 text-[11px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase bg-zinc-100 dark:bg-zinc-800/50">
        {t('chat.debug.title')}
      </div>
      <div className="max-h-48 overflow-y-auto px-2 py-1">
        {messages.map((msg) => {
          const isCall = (msg.role as string) === 'tool_call';
          const contentStr =
            typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          let preview = contentStr.length > 80 ? `${contentStr.substring(0, 80)}...` : contentStr;
          try {
            const json = JSON.parse(contentStr);
            if (json && json['function']) {
              preview = `${json['function']}(${JSON.stringify(json['arguments'])})`;
            }
          } catch {
            /* use raw */
          }

          return (
            <div key={msg.id} className="flex items-start gap-2 py-0.5">
              <span className="text-[10px] mt-0.5 shrink-0">
                {isCall ? '▶' : '◀'}
              </span>
              <span className="text-[10px] font-mono text-zinc-500 dark:text-zinc-400 leading-relaxed break-all">
                {preview}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ChatPage() {
  const t = useT();
  const {
    activeConversation,
    messages,
    debugMessages,
    isStreaming,
    error,
    toolMode,
    customTools,
    sendMessage,
    clearError,
    setToolMode,
    createConversation,
    loadConversations,
    loadMessages,
  } = useChatStore();

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showLog, setShowLog] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showConversations, setShowConversations] = useState(false);

  // Auto-scroll when messages change
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
    }
  }, [messages]);

  // Load conversations on mount
  useEffect(() => {
    loadConversations();
  }, [loadConversations]);

  const handleSend = useCallback(
    async (content: MessageContent) => {
      // For now, password is empty string (will be wired to password dialog later)
      await sendMessage(content, '');
    },
    [sendMessage],
  );

  const handleToolModeChange = useCallback(
    (mode: ToolMode) => {
      if (mode === ToolMode.custom) {
        // For now, just set custom mode with empty set; tool picker will be added in Phase 5
        setToolMode(mode);
      } else {
        setToolMode(mode);
      }
    },
    [setToolMode],
  );

  const handleDismissError = useCallback(() => {
    clearError();
  }, [clearError]);

  const hasMessages = messages.length > 0;

  return (
    <div className="flex-1 flex flex-col min-h-0 relative">
      {/* Top Bar */}
      <header className="flex items-center gap-2 px-3 h-12 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 shrink-0">
        {/* Mobile: conversations button */}
        <button
          onClick={() => setShowConversations(true)}
          className="lg:hidden p-1.5 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800 rounded-lg"
        >
          <Menu size={18} />
        </button>

        {/* Title */}
        <h1 className="flex-1 text-[14px] font-semibold text-zinc-800 dark:text-zinc-200 truncate">
          {activeConversation?.title ?? t('chat.title.new')}
        </h1>

        {/* Log toggle */}
        <button
          onClick={() => setShowLog(!showLog)}
          className={`p-1.5 rounded-lg transition-colors ${
            showLog
              ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
              : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
          }`}
          title="Execution Log"
        >
          <Terminal size={18} />
        </button>

        {/* Debug toggle */}
        {debugMessages.length > 0 && (
          <button
            onClick={() => setShowDebug(!showDebug)}
            className={`p-1.5 rounded-lg transition-colors ${
              showDebug
                ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300'
                : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300'
            }`}
            title="Tool Debug Panel"
          >
            <Bug size={18} />
          </button>
        )}

        {/* Model switcher */}
        <ModelSwitcher />

        {/* Desktop: conversations button */}
        <button
          onClick={() => setShowConversations(true)}
          className="hidden lg:block p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 rounded-lg"
          title="Conversations"
        >
          <Menu size={18} />
        </button>
      </header>

      {/* Conversations panel */}
      <ConversationsPanel open={showConversations} onClose={() => setShowConversations(false)} />

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-3 mx-3 mt-2 px-3 py-2 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg text-[13px] text-red-700 dark:text-red-300">
          <span className="flex-1">{error}</span>
          <button onClick={handleDismissError} className="font-medium hover:underline shrink-0">
            {t('common.dismiss')}
          </button>
        </div>
      )}

      {/* Messages area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {hasMessages ? (
          <div className="py-2">
            {messages.map((msg, i) => (
              <ChatBubble key={msg.id} message={msg} previousMessage={i > 0 ? messages[i - 1] : undefined} />
            ))}
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center h-full text-zinc-400 dark:text-zinc-500 px-4">
            <MessageCircle size={56} className="mb-4 opacity-30" />
            <h2 className="text-lg font-semibold text-zinc-500 dark:text-zinc-400 mb-2">
              {t('chat.empty.title')}
            </h2>
            <p className="text-[13px] text-center max-w-xs whitespace-pre-line leading-relaxed">
              {t('chat.empty.subtitle')}
            </p>
            <a
              href="/models?new=true"
              className="mt-6 inline-flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-full text-[14px] font-medium hover:bg-blue-700 transition-colors"
            >
              <Plus size={16} />
              {t('chat.empty.action')}
            </a>
          </div>
        )}
      </div>

      {/* Execution log panel */}
      {showLog && (
        <div className="mx-2 mb-1 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50/50 dark:bg-zinc-900/50 h-36 overflow-y-auto">
          <div className="px-3 py-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
            Execution log — messages will appear here after sending
          </div>
        </div>
      )}

      {/* Tool mode bar */}
      <ToolModeBar
        mode={toolMode}
        selectedCount={customTools.size}
        onModeChanged={handleToolModeChange}
      />

      {/* Message input */}
      <MessageInput
        enabled={!isStreaming}
        hintText={t('chat.input.hint')}
        onSend={handleSend}
      />

      {/* Debug panel */}
      <DebugPanel messages={debugMessages} open={showDebug} />
    </div>
  );
}
