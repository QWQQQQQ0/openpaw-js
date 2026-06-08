export interface FloatChatMsg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  images?: string[];
  status: 'done' | 'streaming' | 'error';
}

export interface ActionLog {
  action: string;
  success: boolean;
  error?: string;
}

export type FloatMode = 'chat' | 'task' | 'watcher' | 'recorder' | 'learn';
