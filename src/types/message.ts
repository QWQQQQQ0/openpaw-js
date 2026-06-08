// 来源: lib/models/chat_message.dart (ChatMessage 类)
// 来源: lib/adapters/llm_adapter.dart (LLMMessage 类)

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type TextContent = { type: 'text'; text: string };
export type ImageContent = { type: 'image_url'; image_url: { url: string } };
export type ContentPart = TextContent | ImageContent;
export type MessageContent = string | ContentPart[];

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: ChatRole;
  content: MessageContent;
  timestamp: string;
  status: 'sending' | 'streaming' | 'done' | 'error';
  toolCalls?: ToolCall[];
  /** MiMo 等模型的思考链内容，回传时必须保留以避免 400 错误 */
  reasoning_content?: string;
}

export interface LLMMessage {
  role: ChatRole;
  content?: string | ContentPart[] | null;
  toolCallId?: string;
  toolCallName?: string;
  toolCalls?: ToolCall[];
  /** MiMo 等模型的思考链内容，多轮工具调用场景必须回传 */
  reasoning_content?: string;
}

export interface ToolCall {
  id: string;
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolCallResult {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** callWithTools 返回值：工具调用 + assistant 消息（用于累积上下文） */
export interface ToolCallResponse {
  toolCalls: ToolCallResult[];
  /** assistant 消息，包含 tool_calls 字段，可直接 push 到消息历史 */
  assistantMessage: LLMMessage;
}
