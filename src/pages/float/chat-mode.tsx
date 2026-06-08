import { useState, useRef, useCallback, useEffect, useImperativeHandle, forwardRef } from 'react';
import { extractBbox, BboxOverlay } from '@/components/bbox-overlay';
import { MessageInput } from '@/components/chat/message-input';
import type { MessageContent, LLMMessage, ContentPart } from '@/types/message';
import { readLocal } from './utils';
import type { FloatChatMsg } from './types';

export interface ChatModeHandle {
  clearMessages: () => void;
}

interface Props {
  sendToModel: boolean;
  allowImagePaste: boolean;
  noSystemPrompt: boolean;
}

const ChatMode = forwardRef<ChatModeHandle, Props>(function ChatMode({ sendToModel, allowImagePaste, noSystemPrompt }, ref) {
  const [chatMessages, setChatMessages] = useState<FloatChatMsg[]>([]);
  const [chatStreaming, setChatStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    clearMessages: () => setChatMessages([]),
  }));

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const handleChatSend = useCallback(async (content: MessageContent) => {
    const id = crypto.randomUUID();
    const text = typeof content === 'string' ? content : (content.find((p) => p.type === 'text') as { text: string } | undefined)?.text ?? '';
    const imageParts = typeof content === 'string' ? [] : content.filter((p) => p.type === 'image_url') as { image_url: { url: string } }[];
    const images = imageParts.map((p) => p.image_url.url);

    const userMsg: FloatChatMsg = { id, role: 'user', text, images, status: 'done' };
    setChatMessages((prev) => [...prev, userMsg]);

    if (!readLocal('float_send_to_model', true)) return;

    setChatStreaming(true);
    const assistantId = crypto.randomUUID();
    setChatMessages((prev) => [...prev, { id: assistantId, role: 'assistant', text: '', status: 'streaming' }]);

    try {
      const { useModelConfigStore } = await import('@/stores/model-config-store');
      await useModelConfigStore.getState().load();
      const config = useModelConfigStore.getState().defaultConfig();
      if (!config) throw new Error('No model configured');

      let apiKey = '';
      try {
        apiKey = await useModelConfigStore.getState().getApiKey(config.id, '');
      } catch (e) {
        throw new Error(`Decrypt API key failed: ${e}`);
      }
      if (!apiKey) throw new Error('API key is empty after decrypt');

      const { ModelScenario } = await import('@/adapters/model-call-service');
      const { getModelService } = await import('@/services/model-service-singleton');
      const modelService = getModelService();

      const llmMessages: LLMMessage[] = chatMessages.map((m) => {
        const parts: ContentPart[] = [];
        if (m.text) parts.push({ type: 'text', text: m.text });
        if (m.images) {
          for (const img of m.images) parts.push({ type: 'image_url', image_url: { url: img } });
        }
        return {
          role: m.role,
          content: parts.length === 1 && parts[0].type === 'text' ? (parts[0] as { type: 'text'; text: string }).text : parts.length > 0 ? parts : null,
        };
      });

      const currentParts: ContentPart[] = [];
      if (text) currentParts.push({ type: 'text', text });
      for (const img of images) currentParts.push({ type: 'image_url', image_url: { url: img } });
      llmMessages.push({
        role: 'user',
        content: currentParts.length === 1 && currentParts[0].type === 'text' ? currentParts[0].text : currentParts,
      });

      const stream = modelService.chatStream({
        scenario: noSystemPrompt ? ModelScenario.raw : ModelScenario.chat,
        messages: llmMessages,
        provider: config,
        apiKey,
      });

      let responseText = '';
      for await (const chunk of stream) {
        if (chunk.startsWith('__ERROR__:')) throw new Error(chunk.substring(10));
        if (chunk.startsWith('__TOOLS__:') || chunk.startsWith('__REASONING__:')) continue;
        responseText += chunk;
        setChatMessages((prev) => prev.map((m) =>
          m.id === assistantId ? { ...m, text: responseText } : m,
        ));
      }

      setChatMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, status: 'done' } : m,
      ));
    } catch (e) {
      setChatMessages((prev) => prev.map((m) =>
        m.id === assistantId ? { ...m, status: 'error', text: `Error: ${e}` } : m,
      ));
    } finally {
      setChatStreaming(false);
    }
  }, [sendToModel, chatMessages, noSystemPrompt]);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 min-h-0 scrollbar-hide">
        {chatMessages.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-400 dark:text-zinc-500 text-[13px]">
            {sendToModel ? 'Start a conversation' : 'Paste or type content to save locally'}
          </div>
        )}
        {chatMessages.map((msg, i) => {
          const prevMsg = i > 0 ? chatMessages[i - 1] : undefined;
          const bbox = msg.role === 'assistant' && msg.status === 'done' && prevMsg?.images?.length ? extractBbox(msg.text) : null;
          return (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-xl px-3 py-2 text-[13px] leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-blue-600 text-white'
                  : msg.status === 'error'
                  ? 'bg-red-50 dark:bg-red-950 text-red-600 dark:text-red-400'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100'
              }`}>
                {msg.images && msg.images.length > 0 && (
                  <div className="flex gap-1 mb-1 flex-wrap">
                    {msg.images.map((img, i) => (
                      <img key={i} src={img} alt="" className="max-w-[120px] max-h-[80px] rounded object-cover" />
                    ))}
                  </div>
                )}
                {msg.text && <div className="whitespace-pre-wrap break-words">{msg.text}</div>}
                {bbox && <BboxOverlay imageUrl={prevMsg!.images![0]} bbox={bbox} />}
                {msg.status === 'streaming' && !msg.text && (
                  <span className="inline-block w-2 h-4 bg-zinc-400 animate-pulse rounded-sm" />
                )}
              </div>
            </div>
          );
        })}
        <div ref={chatEndRef} />
      </div>

      <MessageInput
        onSend={handleChatSend}
        enabled={!chatStreaming}
        hintText={sendToModel ? 'Send message...' : 'Type to save locally...'}
        allowImagePaste={allowImagePaste}
      />
    </>
  );
});

export default ChatMode;
