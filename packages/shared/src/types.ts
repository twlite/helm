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
  mode?: 'exists' | 'non-empty' | 'contains-facts' | 'contains-text' | 'downloaded' | 'matches-fact'
    | 'written' | 'written-from-artifact' | 'created' | 'open' | 'opened';
  freshness?: 'current-run';
  action?: 'fs.write' | 'fs.mkdir' | 'app.openFile';
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
  version?: number;
  size?: number;
  sha256?: string;
  sourceUrl?: string;
  sourceRef?: string;
  sourceType?: BrowserContentType;
  sourceRevision?: number;
  format?: BrowserContentFormat;
  writeReceiptId?: string;
  download?: DownloadRecord;
  observedAt: string;
}

export interface ActionEffect {
  /** URL supplied to browser.navigate before the browser followed redirects. */
  requestedUrl?: string;
  urlBefore?: string;
  urlAfter?: string;
  /** True when browser.navigate finished at a URL different from requestedUrl. */
  redirected?: boolean;
  navigationOccurred?: boolean;
  newTabOpened?: boolean;
  domChanged?: boolean;
  browserRevisionBefore?: number;
  browserRevisionAfter?: number;
  path?: string;
  existsBefore?: boolean;
  existsAfter?: boolean;
  beforeSha256?: string;
  bytesWritten?: number;
  sha256?: string;
  writePerformed?: boolean;
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
    loading?: boolean;
    pageCount?: number;
    revision?: number;
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

export type MemorySource = 'user' | 'observed' | 'manual' | 'passive-extraction';

export type MemoryDurability = 'durable' | 'refreshable';

export interface Memory {
  id: string;
  content: string;
  kind: 'fact' | 'preference' | 'instruction' | 'note';
  importance: number;
  metadata: JsonObject;
  key?: string;
  source?: MemorySource;
  sourceUrl?: string;
  evidenceIds?: string[];
  durability?: MemoryDurability;
  lastVerifiedAt?: string;
  lastAccessedAt?: string;
  accessCount?: number;
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
  | 'fs.mkdir'
  | 'fs.exists'
  | 'fs.list'
  | 'fs.stat'
  | 'browser.navigate'
  | 'browser.getState'
  | 'browser.snapshot'
  | 'browser.read'
  | 'browser.search'
  | 'browser.open'
  | 'browser.inspectRegion'
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
    | 'run.progress'
    | 'run.context.usage'
    | 'run.context.compacted'
    | 'run.memory.recalled'
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

export type BrowserRegionKind =
  | 'heading'
  | 'section'
  | 'article'
  | 'table'
  | 'list'
  | 'form'
  | 'navigation'
  | 'text'
  | 'footer'
  | 'aside';

export interface BrowserPageRegion {
  ref: string;
  kind: BrowserRegionKind;
  heading?: string;
  preview?: string;
  rowCount?: number;
  columnCount?: number;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  pageCount: number;
  revision: number;
  regionCount: number;
  outlineTruncated: boolean;
  outline: BrowserPageRegion[];
  elements: Array<{
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
}

export interface BrowserSearchResult extends BrowserPageRegion {
  score: number;
  snippet?: string;
}

export interface BrowserSearchPageResult {
  operation: 'search';
  searchCompleted: true;
  url: string;
  title: string;
  revision: number;
  query: string;
  semanticBlockCount: number;
  matchCount: number;
  pageReadable: boolean;
  message: string;
  results: BrowserContentSummary[];
}

export interface BrowserOpenResult {
  ref: string;
  openedHref: string;
  sourceType: BrowserContentType;
  url: string;
  title: string;
  loading: boolean;
  pageCount: number;
  revision: number;
}

export type BrowserReadMode = 'readable' | 'document';

export type BrowserPageType =
  | 'article'
  | 'data_table'
  | 'search_results'
  | 'documentation'
  | 'form'
  | 'application'
  | 'generic';

export type BrowserContentType =
  | 'text'
  | 'heading'
  | 'table'
  | 'list'
  | 'code'
  | 'form'
  | 'definition'
  | 'navigation'
  | 'search_result'
  | 'other';

export type BrowserContentFormat = 'text' | 'markdown' | 'json' | 'csv';

export interface BrowserContentSource {
  frameUrl?: string;
  frameName?: string;
  extractor?: 'dom' | 'aria' | 'readability';
}

export interface BrowserContentLink {
  text: string;
  href: string;
}

/** Complete local browser artifact retained outside the model context. */
export interface BrowserContentBlock {
  ref: string;
  type: BrowserContentType;
  text?: string;
  heading?: string;
  headingPath?: string[];
  source?: BrowserContentSource;
  role?: string;
  importance?: number;
  relevance?: number;
  boilerplate?: boolean;
  caption?: string;
  columns?: string[];
  rows?: string[][];
  /** Per source cell, retain the original HTML/ARIA span information. */
  cellSpans?: Array<Array<{ rowspan: number; colspan: number }>>;
  rowCount?: number;
  columnCount?: number;
  ordered?: boolean;
  items?: string[];
  fields?: Array<{ label: string; type?: string; value?: string; required?: boolean }>;
  definitions?: Array<{ term: string; definition: string }>;
  links?: BrowserContentLink[];
  title?: string;
  href?: string;
  snippet?: string;
  language?: string;
  truncated?: boolean;
}

/** Compact summary returned by browser.read; full blocks stay in the guest registry. */
export interface BrowserContentSummary extends Omit<BrowserContentBlock, 'text' | 'rows' | 'items' | 'definitions' | 'fields' | 'links'> {
  preview?: string;
  offset?: number;
  nextOffset?: number;
  returnedChars?: number;
  returnedRowCount?: number;
  rows?: string[][];
  items?: string[];
  definitions?: Array<{ term: string; definition: string }>;
  fields?: Array<{ label: string; type?: string; value?: string; required?: boolean }>;
  links?: BrowserContentLink[];
}

export interface BrowserReadSection {
  heading?: string;
  text: string;
  ref?: string;
}

export interface BrowserReadResult {
  operation: 'read';
  url: string;
  title: string;
  revision: number;
  mode: BrowserReadMode;
  source: 'semantic';
  pageType?: BrowserPageType;
  query?: string;
  blocks?: BrowserContentSummary[];
  diagnostics?: {
    blockCount: number;
    tableCount: number;
    selectedRefs: Array<{ ref: string; relevance?: number }>;
    extractors: string[];
    inaccessibleFrames?: number;
  };
  readable: boolean;
  sections: BrowserReadSection[];
  totalChars: number;
  returnedChars: number;
  truncated: boolean;
}

export type BrowserRegionInspection =
  | {
      url: string;
      title: string;
      revision: number;
      ref: string;
      kind: BrowserRegionKind;
      heading?: string;
      format: 'text';
      text: string;
      truncated: boolean;
    }
  | {
      url: string;
      title: string;
      revision: number;
      ref: string;
      kind: 'table';
      heading?: string;
      format: 'table';
      columns: string[];
      rows: string[][];
      rowCount: number;
      returnedRowCount: number;
      offset: number;
      columnCount: number;
      truncated: boolean;
    }
  | {
      url: string;
      title: string;
      revision: number;
      ref: string;
      kind: BrowserRegionKind;
      heading?: string;
      format: 'links';
      links: Array<{ text: string; href: string }>;
      linkCount: number;
      truncated: boolean;
    };
