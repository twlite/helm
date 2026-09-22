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

export type RequirementType =
  | 'fact'
  | 'artifact'
  | 'filesystem'
  | 'browser'
  | 'desktop'
  | 'semantic';

export type RequirementStatus = 'pending' | 'satisfied' | 'blocked';

export type FactOrigin = 'user' | 'observed' | 'derived' | 'hypothesis';

export type FactConfidence = 'user-provided' | 'observed' | 'derived' | 'hypothesis';

export interface TaskConstraint {
  id: string;
  description: string;
  source: 'user' | 'compiler';
}

export interface RequirementTarget {
  path?: string;
  url?: string;
  factIds?: string[];
  content?: string;
  mode?: 'exists' | 'contains-facts' | 'contains-text' | 'downloaded' | 'matches-fact';
  factId?: string;
}

export interface TaskRequirement {
  id: string;
  description: string;
  type: RequirementType;
  mandatory: boolean;
  status?: RequirementStatus;
  /** Targets are compiler-owned and are only populated from user text or observed state. */
  target?: RequirementTarget;
  /** A legacy criterion may be retained as a deterministic compatibility check. */
  criterion?: CompletionCriterion;
}

export interface EvidenceSource {
  type: 'user' | 'browser' | 'filesystem' | 'desktop' | 'action' | 'system' | 'verification';
  url?: string;
  observationId?: string;
  actionId?: string;
}

export interface Evidence {
  id: string;
  type: EvidenceSource['type'];
  summary: string;
  data: JsonValue;
  source?: EvidenceSource;
  observedAt: string;
}

export interface Fact {
  id: string;
  value: JsonValue;
  origin: FactOrigin;
  confidence: FactConfidence;
  evidenceIds: string[];
  source?: EvidenceSource;
  observedAt: string;
}

export interface DownloadRecord {
  sourceUrl: string;
  finalUrl?: string;
  suggestedFilename?: string;
  savedPath?: string;
  size?: number;
  context?: string;
  startedAt: string;
}

export interface Artifact {
  id: string;
  type: 'file' | 'directory' | 'download';
  path: string;
  size?: number;
  sha256?: string;
  sourceUrl?: string;
  download?: DownloadRecord;
  observedAt: string;
}

export interface ActionEffect {
  urlBefore?: string;
  urlAfter?: string;
  navigationOccurred?: boolean;
  newTabOpened?: boolean;
  domChanged?: boolean;
  path?: string;
  existsBefore?: boolean;
  existsAfter?: boolean;
  bytesWritten?: number;
  sha256?: string;
  downloadStarted?: boolean;
  download?: DownloadRecord;
  changed?: boolean;
}

export interface ActionReceipt {
  id: string;
  tool: string;
  ok: boolean;
  effect?: ActionEffect;
  startedAt: string;
  completedAt: string;
  error?: ToolError;
}

export interface WorkerAction {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  result: ToolResult;
  receipt?: ActionReceipt;
}

export type WorkerKind = 'browser' | 'filesystem' | 'desktop' | 'system';

export interface WorkerObjective {
  id: string;
  kind: WorkerKind;
  description: string;
  requirementIds: string[];
  rationale: string;
  recovery?: boolean;
}

export interface Blocker {
  code: string;
  message: string;
  requirementIds?: string[];
  strategy?: string;
  details?: JsonValue;
}

export interface FailedStrategy {
  signature: string;
  objectiveId: string;
  description: string;
  reason: string;
  attempts: number;
  recordedAt: string;
}

export interface ProgressState {
  fingerprint: string;
  changed: boolean;
  noProgressStreak: number;
  recoveryAttempts: number;
  recoveryActive: boolean;
  reason?: string;
}

export interface TaskState {
  task: TaskDefinition;
  facts: Fact[];
  evidence: Evidence[];
  artifacts: Artifact[];
  completedRequirementIds: string[];
  currentObjective?: WorkerObjective;
  currentEnvironment?: EnvironmentObservation;
  recentActions: WorkerAction[];
  failedStrategies: FailedStrategy[];
  blockers: Blocker[];
  progress: ProgressState;
  workerResults: WorkerResult[];
}

export type OrchestratorDecision =
  | {
      type: 'objective';
      objective: WorkerObjective;
      reasoningSummary?: string;
    }
  | { type: 'complete'; reasoningSummary?: string }
  | { type: 'blocked'; blocker: Blocker; reasoningSummary?: string };

export type WorkerResultStatus = 'completed' | 'blocked' | 'failed';

export interface WorkerResult {
  status: WorkerResultStatus;
  worker: WorkerKind;
  objectiveId: string;
  actions: WorkerAction[];
  facts: Fact[];
  evidence: Evidence[];
  artifacts: Artifact[];
  blockers: Blocker[];
  environmentChanged: boolean;
  suggestedNextInformation?: string;
  reasoningSummary?: string;
}

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
  originalRequest?: string;
  requirements?: TaskRequirement[];
  constraints?: TaskConstraint[];
  isConversation?: boolean;
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
    pageCount?: number;
    domFingerprint?: string;
    main?: {
      heading?: string;
      text?: string;
    };
    interactiveElements?: Array<{
      ref: string;
      role: string;
      name: string;
      value?: string;
      text?: string;
      enabled: boolean;
      href?: string;
      checked?: boolean;
      selected?: boolean;
    }>;
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
  requirements?: Array<{
    requirement: TaskRequirement;
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
  /** Earlier messages in the thread, including the current user request. */
  conversation?: readonly Message[];
  stepIndex: number;
  previousResults: ToolResult[];
  signal?: AbortSignal;
}

export interface Run {
  id: string;
  threadId: string;
  sourceMessageId?: string;
  goal: string;
  status: RunStatus;
  criteria: CompletionCriterion[];
  task?: TaskDefinition;
  state?: TaskState;
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
  orchestratorDecision?: OrchestratorDecision;
  objective?: WorkerObjective;
  worker?: WorkerKind;
  workerResult?: WorkerResult;
  progress?: ProgressState;
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
  uncleanShutdownDetected?: boolean;
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
  | 'browser.download'
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
    | 'assistant.message.started'
    | 'assistant.message.delta'
    | 'assistant.message.finished'
    | 'message.created'
    | 'desktop.screenshot';
  timestamp: string;
  runId?: string;
  payload: JsonValue;
}
