import type {
  AgentDecision,
  HealthStatus,
  Memory,
  Message,
  Run,
  RunStep,
  Thread,
  ToolResult,
  VmStatus,
  WebSocketEvent,
} from '@helm/shared';

export type {
  AgentDecision,
  HealthStatus,
  Memory,
  Message,
  Run,
  RunStep,
  Thread,
  ToolResult,
  VmStatus,
};

export type RunDetails = Run & {
  steps: RunStep[];
};

export type LiveActivityPhase =
  | 'starting'
  | 'thinking'
  | 'verifying'
  | 'recorded'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type LiveActivity = {
  runId: string;
  phase: LiveActivityPhase;
  stepIndex?: number;
  toolName?: string;
  reasoningSummary?: string;
};

export type StreamingAssistantMessage = {
  threadId: string;
  runId: string;
  messageId: string;
  content: string;
  status: 'writing' | 'finished';
};

export type WebSocketEventType = WebSocketEvent['type'];

export type HelmEvent = {
  type: WebSocketEventType;
  timestamp: string;
  runId?: string;
  payload: unknown;
};

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'offline';

export type AsyncState = 'idle' | 'loading' | 'saving' | 'error';

export type VmAction = 'start' | 'stop' | 'reset' | 'reconnect';

export type MemoryKind = Memory['kind'];

export type DisplayToolResult = ToolResult<unknown>;

export type ActionDecision = Extract<AgentDecision, { type: 'action' }>;
