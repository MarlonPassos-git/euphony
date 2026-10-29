export const CONTEXT_CATEGORIES = {
  base: 'Base instructions',
  instructions: 'Developer instructions',
  agents: 'AGENTS.md',
  skills: 'Skill catalog',
  memory: 'Memory',
  hooks: 'Hook context',
  environment: 'Environment & plugins',
  tools: 'Built-in tool definitions',
  mcp: 'MCP tool definitions',
  conversation: 'Conversation',
  calls: 'Tool calls',
  results: 'Tool results',
  summary: 'Compaction summary'
} as const;

export type ContextCategory = keyof typeof CONTEXT_CATEGORIES;

export interface ContextSource {
  id: string;
  category: ContextCategory;
  title: string;
  origin: string;
  evidence: string;
  text: string;
  tokens: number;
  stateOnly: boolean;
  delivery: string;
}

export interface ContextCheckpoint {
  id: string;
  label: string;
  end: number;
  input: number | null;
  output: number | null;
  window: number | null;
}

export interface ContextReport {
  sources: ContextSource[];
  estimatedTokens: number;
  notices: string[];
  checkpoint: ContextCheckpoint;
}
