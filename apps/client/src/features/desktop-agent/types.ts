export type StreamState = 'idle' | 'streaming' | 'error';

export interface LiveToolCall {
  toolName: string;
  input: Record<string, unknown>;
}

export interface LiveToolResult {
  toolName: string;
  output: Record<string, unknown>;
}
