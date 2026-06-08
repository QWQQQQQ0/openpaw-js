// 来源: lib/adapters/anthropic_adapter.dart

import type { LLMMessage } from '@/types/message';
import type { LLMAdapter } from './types';

export class AnthropicAdapter implements LLMAdapter {
  readonly adapterId = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly defaultBaseUrl = 'https://api.anthropic.com';

  async *chat({ messages, model, apiKey, baseUrl, tools, thinkingMode }: {
    messages: LLMMessage[];
    model: string;
    apiKey: string;
    baseUrl?: string;
    tools?: Record<string, unknown>[];
    thinkingMode?: boolean;
  }): AsyncGenerator<string> {
    console.debug('[anthropic] POST msgs=', messages.length, 'tools=', tools?.length ?? 0, 'model=', model);
    const url = `${baseUrl ?? this.defaultBaseUrl}/v1/messages`;

    // Separate system messages from conversation
    const systemMessages = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content?.toString() ?? '');
    const conversationMessages = convertMessagesForAnthropic(
      messages.filter((m) => m.role !== 'system')
    );

    const body: Record<string, unknown> = {
      model,
      messages: conversationMessages,
      max_tokens: 4096,
      stream: true,
    };
    if (systemMessages.length > 0) {
      body['system'] = systemMessages.join('\n');
    }
    if (tools && tools.length > 0) {
      body['tools'] = convertTools(tools);
    }

    // MiMo thinking models: enable thinking mode
    if (thinkingMode) {
      body['thinking'] = { type: 'enabled' };
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '(no body)');
      throw new Error(`Anthropic API error ${response.status}: ${errBody}`);
    }
    if (!response.body) throw new Error('Anthropic API response has no body');

    const toolUseBlocks = new Map<number, Record<string, unknown>>();

    for await (const line of decodeStreamToLines(response.body)) {
      if (!line.startsWith('data: ')) continue;
      const data = line.substring(6).trim();
      if (data === '[DONE]') break;

      try {
        const json = JSON.parse(data);
        const type = json['type'] as string | undefined;

        if (type === 'content_block_start') {
          const block = json['content_block'] as Record<string, unknown> | undefined;
          if (block && block['type'] === 'tool_use') {
            const index = json['index'] as number;
            toolUseBlocks.set(index, {
              id: block['id'],
              name: block['name'],
              _jsonBuf: '',
            });
          }
        } else if (type === 'content_block_delta') {
          const delta = json['delta'] as Record<string, unknown> | undefined;
          if (delta?.['type'] === 'input_json_delta') {
            const idx = json['index'] as number;
            const partial = (delta['partial_json'] as string) ?? '';
            const block = toolUseBlocks.get(idx);
            if (block) block['_jsonBuf'] = (block['_jsonBuf'] as string) + partial;
          }
          const text = delta?.['text'] as string | undefined;
          if (text && text.length > 0) yield text;
        }
        // content_block_stop — handled at stream end
      } catch {
        // Skip malformed SSE chunks
      }
    }

    // Emit tool calls if any were accumulated
    if (toolUseBlocks.size > 0) {
      const calls = Array.from(toolUseBlocks.values()).map((b) => {
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(b['_jsonBuf'] as string);
        } catch {
          input = {};
        }
        return {
          id: b['id'],
          function: {
            name: b['name'],
            arguments: JSON.stringify(input),
          },
        };
      });
      yield `__TOOLS__:${JSON.stringify(calls)}`;
    }
  }
}

// Convert OpenAI-format tools to Anthropic format
function convertTools(tools: Record<string, unknown>[]): Record<string, unknown>[] {
  return tools.map((t) => {
    const func = t['function'] as Record<string, unknown>;
    return {
      name: func['name'],
      description: func['description'],
      input_schema: func['parameters'],
    };
  });
}

// Convert LLMMessages to Anthropic Messages API format
function convertMessagesForAnthropic(messages: LLMMessage[]): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];

  for (const m of messages) {
    const content = m.content;

    // Tool result with multimodal content (images + text)
    if (m.role === 'tool' && Array.isArray(content)) {
      const toolResultContent: Array<Record<string, unknown>> = [];
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (p['type'] === 'image_url') {
          const iu = p['image_url'] as Record<string, unknown>;
          let url = iu['url'] as string;
          let mediaType: string | undefined;
          let data: string;
          if (url.startsWith('data:')) {
            const comma = url.indexOf(',');
            if (comma >= 0) {
              const header = url.substring(5, comma);
              const semicolon = header.indexOf(';');
              mediaType = semicolon >= 0 ? header.substring(0, semicolon) : header;
              data = url.substring(comma + 1);
            } else {
              data = url.substring(5);
            }
          } else {
            data = url;
          }
          toolResultContent.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType ?? 'image/png',
              data,
            },
          });
        } else if (p['type'] === 'text') {
          toolResultContent.push({ type: 'text', text: p['text'] });
        }
      }
      result.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: toolResultContent,
        }],
      });
    }
    // Multimodal user/assistant message
    else if (Array.isArray(content)) {
      const parts: Array<Record<string, unknown>> = [];
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (p['type'] === 'image_url') {
          const iu = p['image_url'] as Record<string, unknown>;
          let url = iu['url'] as string;
          let mediaType: string | undefined;
          let data: string;
          if (url.startsWith('data:')) {
            const comma = url.indexOf(',');
            if (comma >= 0) {
              const header = url.substring(5, comma);
              const semicolon = header.indexOf(';');
              mediaType = semicolon >= 0 ? header.substring(0, semicolon) : header;
              data = url.substring(comma + 1);
            } else {
              data = url.substring(5);
            }
          } else {
            data = url;
          }
          parts.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mediaType ?? 'image/png',
              data,
            },
          });
        } else if (p['type'] === 'text') {
          parts.push({ type: 'text', text: p['text'] });
        }
      }
      result.push({ role: m.role, content: parts });
    }
    // Assistant message with tool calls
    else if (m.toolCalls && m.toolCalls.length > 0) {
      const blocks: Array<Record<string, unknown>> = [];
      if (content != null && content.toString().length > 0) {
        blocks.push({ type: 'text', text: content.toString() });
      }
      for (const tc of m.toolCalls) {
        const func = tc['function'] as Record<string, unknown>;
        let input: Record<string, unknown>;
        try {
          input = JSON.parse(func['arguments'] as string);
        } catch {
          input = {};
        }
        blocks.push({
          type: 'tool_use',
          id: tc['id'],
          name: func['name'],
          input,
        });
      }
      result.push({ role: 'assistant', content: blocks });
    }
    // Tool result message
    else if (m.role === 'tool') {
      result.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: m.toolCallId ?? '',
          content: content?.toString() ?? '',
        }],
      });
    }
    // Plain text message
    else {
      result.push({
        role: m.role,
        content: content?.toString() ?? '',
      });
    }
  }
  return result;
}

// Replicate LLMAdapter.decodeStreamToLines
async function* decodeStreamToLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) yield line;
    if (done) {
      if (buffer.length > 0) yield buffer;
      break;
    }
  }
}
