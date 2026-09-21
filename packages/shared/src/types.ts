export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export type RunStatus =
  | 'pending'
  | 'running'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunStepPhase =
  | 'observe'
  | 'reason'
  | 'act'
  | 'verify'
  | 'complete'
  | 'blocked'
  | 'failed';

export interface Thread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  metadata: JsonObject;
  createdAt: string;
}

export type CompletionCriterion =
  | { type: 'browser.url'; url: string }
  | { type: 'file.exists'; path: string }
  | { type: 'file.contains'; path: string; expected: string }
  | {
      type: 'window.open';
      application?: string;
      titleIncludes?: string;
    }
  | {
      type: 'window.focused';
      application?: string;
      titleIncludes?: string;
    }
  | { type: 'custom'; id: string; description: string };

export interface TaskDefinition {
  id: string;
  threadId: string;
  goal: string;
  criteria: CompletionCriterion[];
  maxSteps?: number;
}

export interface WindowInfo {
  id: string;
  application?: string;
  title: string;
  focused: boolean;
}

export interface ToolError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: ToolError;
  evidence?: unknown;
}

export interface EnvironmentObservation {
  timestamp: number;
  desktop?: {
    focusedWindow?: WindowInfo;
    windows?: WindowInfo[];
    screenshotId?: string;
  };
  browser?: {
    url?: string;
    title?: string;
    loaded?: boolean;
  };
  lastToolResult?: ToolResult;
  task: {
    completedCriteria: string[];
    remainingCriteria: string[];
  };
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface VerificationResult {
  complete: boolean;
  criteria: Array<{
    criterion: CompletionCriterion;
    passed: boolean;
    message: string;
    evidence?: unknown;
  }>;
  summary: string;
}

export interface AgentStep {
  reasoningSummary?: string;
  action?: ToolCall;
  observation?: EnvironmentObservation | unknown;
  verification?: VerificationResult;
}

export type AgentDecision =
  | {
      type: 'action';
      tool: string;
      input: Record<string, unknown>;
      reasoningSummary?: string;
    }
  | { type: 'complete'; reasoningSummary?: string }
  | { type: 'blocked'; reason: string; reasoningSummary?: string };

export interface Memory {
  id: string;
  content: string;
  kind: 'fact' | 'preference' | 'instruction' | 'note';
  importance: number;
  metadata: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTurnContext {
  task: TaskDefinition;
  observation: EnvironmentObservation;
  history: AgentStep[];
  memories: Memory[];
  stepIndex: number;
  previousResults: ToolResult[];
}

export interface Run {
  id: string;
  threadId: string;
  sourceMessageId?: string;
  goal: string;
  status: RunStatus;
  criteria: CompletionCriterion[];
  error?: ToolError;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface RunStep {
  id: string;
  runId: string;
  stepIndex: number;
  phase: RunStepPhase;
  decision?: AgentDecision;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
  observation?: unknown;
  verification?: VerificationResult;
  createdAt: string;
  completedAt?: string;
}

export interface VmStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error' | 'unavailable';
  helperAvailable: boolean;
  guestConnected: boolean;
  message?: string;
  screenshot?: string;
}

export interface HealthStatus {
  ok: boolean;
  database: boolean;
  fts5: boolean;
  sqliteVec: boolean;
  vmHelper: boolean;
  vm: VmStatus;
  browser: boolean;
  desktop: boolean;
}

export interface GuestRequest {
  id: string;
  method: GuestMethod;
  params: Record<string, unknown>;
}

export interface GuestResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ToolError;
}

export type GuestMethod =
  | 'guest.handshake'
  | 'fs.read'
  | 'fs.write'
  | 'fs.exists'
  | 'fs.list'
  | 'fs.stat'
  | 'browser.navigate'
  | 'browser.getState'
  | 'browser.snapshot'
  | 'browser.extractText'
  | 'browser.click'
  | 'browser.type'
  | 'app.launch'
  | 'app.openFile'
  | 'desktop.getState'
  | 'desktop.listWindows'
  | 'desktop.focusWindow'
  | 'desktop.hotkey'
  | 'desktop.type'
  | 'desktop.click'
  | 'desktop.screenshot';

export interface WebSocketEvent {
  type:
    | 'vm.status'
    | 'guest.connected'
    | 'guest.disconnected'
    | 'run.started'
    | 'run.step.started'
    | 'run.step.completed'
    | 'run.verification'
    | 'run.completed'
    | 'run.failed'
    | 'run.cancelled'
    | 'desktop.screenshot';
  timestamp: string;
  runId?: string;
  payload: JsonValue;
}
