export interface CodeParam {
  name: string;
  type: string;
  description: string;
  required?: boolean;
  default?: unknown;
}

export interface CodeEntry {
  id: string;
  name: string;
  description: string;
  language: 'javascript' | 'python' | 'sql' | 'html';
  code: string;
  params: CodeParam[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
  hitCount: number;
}

export interface CodeQueryFilter {
  language?: string;
  tag?: string;
  search?: string;
}
