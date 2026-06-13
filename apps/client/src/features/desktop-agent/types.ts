export type StreamState = 'idle' | 'streaming' | 'error';

export type AgentStatus =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'working'
  | 'responding'
  | 'reading_memory'
  | 'compressing'
  | 'cancelling';

export interface LiveToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface LiveToolResult {
  toolName: string;
  output: Record<string, unknown>;
}

export type LiveStatusKind =
  | 'memory_reading'
  | 'memory_saved'
  | 'context_summarizing'
  | 'context_summarized';

export interface LiveStatusPayload {
  memory_reading: { count?: number; query?: string };
  memory_saved: { toolCallCount?: number };
  context_summarizing: { tokenEstimate?: number };
  context_summarized: {
    summaryId?: string;
    tokenEstimate?: number;
    upToMessageCount?: number;
  };
}

export type LiveEvent =
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; toolName: string; input: Record<string, unknown> }
  | { type: 'tool_result'; toolName: string; output: Record<string, unknown> }
  | { type: 'text'; text: string }
  | { type: 'status'; kind: 'memory_reading'; payload: LiveStatusPayload['memory_reading'] }
  | { type: 'status'; kind: 'memory_saved'; payload: LiveStatusPayload['memory_saved'] }
  | { type: 'status'; kind: 'context_summarizing'; payload: LiveStatusPayload['context_summarizing'] }
  | { type: 'status'; kind: 'context_summarized'; payload: LiveStatusPayload['context_summarized'] };

export interface QueuedMessage {
  id: string;
  text: string;
}
