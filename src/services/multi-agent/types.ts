// Shared types for the multi-agent collaboration system

export type AgentType = 'orchestrator' | 'architect' | 'developer' | 'reviewer' | 'integrator';

export type TaskStatus = 'pending' | 'analyzing' | 'coding' | 'reviewing' | 'done' | 'failed';

export type LogAction = 'analyze' | 'decide_split' | 'code' | 'write_file' | 'read_file' | 'review' | 'fix' | 'negotiate' | 'shell_exec' | 'done';

export interface SplitDecision {
  should_split: boolean;
  score: number;
  pros: string[];
  cons: string[];
  reason: string;
  sub_modules?: Array<{
    name: string;
    description: string;
    files_estimate: number;
  }>;
}

export interface ModuleContract {
  module: string;
  version: string;
  exports: {
    functions: Array<{
      name: string;
      params: Record<string, string>;
      returns: string;
      description: string;
    }>;
    types: Array<{
      name: string;
      fields: Array<{ name: string; type: string }>;
    }>;
  };
  imports: string[];
  db_tables?: string[];
}
