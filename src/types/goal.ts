// Goal parser types — structured output from natural language intent parsing

export interface ParsedGoal {
  tasks: ParsedTask[];
  response: string;
}

export interface ParsedTask {
  name: string;
  type: 'once' | 'timer' | 'screen_change';
  goal: string;
  schedule?: {
    intervalMs?: number;
    cron?: string;
    delayMs?: number;
    at?: number;
  };
  monitor?: {
    app?: string;
    region?: string;
    windowTitle?: string;
  };
  action: {
    type: 'agent_execute' | 'notify';
    goalTemplate: string;
    /** 是否需要截图传给 LLM（默认 true）。纯文本任务如回复消息可设为 false */
    requiresScreenshot?: boolean;
    /** 工具模式：'all'=全量 | 'none'=无 | 'favorites'=收藏 | 'custom'=自定义列表 */
    toolMode?: 'all' | 'none' | 'favorites' | 'custom';
    /** toolMode='custom' 时的工具名列表 */
    customTools?: string[];
  };
  /** screen_change 专用：监控前的准备动作（打开应用、导航到页面等），Watcher 启动时执行一次 */
  preparationGoal?: string;
  /** screen_change 专用：触发后的详细动作描述，比 action.goalTemplate 更具体 */
  actionGoal?: string;
}
