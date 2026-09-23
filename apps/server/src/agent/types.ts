import type {
  AgentDecision,
  AgentStep,
  AgentTurnContext,
  Blocker,
  CompletionCriterion,
  EnvironmentObservation,
  Evidence,
  Fact,
  Memory,
  Message,
  OrchestratorDecision,
  ProgressState,
  Run,
  RunStep,
  TaskState,
  TaskDefinition,
  ToolResult,
  VerificationResult,
  WorkerAction,
  WorkerKind,
  WorkerObjective,
  WorkerResult,
} from '@helm/shared';

import type { GuestTransport } from '../tools/guest-transport';
import type { ToolRegistry } from '../tools/tool-registry';
import type { CriterionVerifierRegistry } from '../tools/criterion-verifier';
import type { ToolDefinition } from '../tools/registry';

export type {
  AgentDecision,
  AgentStep,
  AgentTurnContext,
  Blocker,
  CompletionCriterion,
  EnvironmentObservation,
  Evidence,
  Fact,
  Memory,
  Run,
  RunStep,
  TaskState,
  TaskDefinition,
  ToolResult,
  VerificationResult,
  OrchestratorDecision,
  ProgressState,
  WorkerAction,
  WorkerKind,
  WorkerObjective,
  WorkerResult,
};

export interface TaskPlannerInput {
  threadId: string;
  userMessage: string;
  conversation?: readonly Message[];
  memories?: Memory[];
  signal?: AbortSignal;
}

export interface MemoryRecallInput {
  threadId: string;
  userMessage: string;
  signal?: AbortSignal;
}

export interface TaskPlanner {
  createTask(input: TaskPlannerInput): Promise<TaskDefinition>;
}

/** Compiler boundary: it describes requirements, not a guessed action plan. */
export interface TaskCompiler extends TaskPlanner {}

export interface OrchestratorContext {
  task: TaskDefinition;
  state: TaskState;
  observation: EnvironmentObservation;
  verification: VerificationResult;
  memories: Memory[];
  conversation?: readonly Message[];
  stepIndex: number;
  signal?: AbortSignal;
}

export interface OrchestratorProvider {
  next(input: OrchestratorContext): Promise<OrchestratorDecision>;
}

export interface WorkerExecutionContext {
  execute(tool: string, input: Record<string, unknown>): Promise<ToolResult>;
  observe(): Promise<EnvironmentObservation>;
  signal?: AbortSignal;
}

export interface WorkerContext {
  objective: WorkerObjective;
  task: TaskDefinition;
  state: TaskState;
  observation: EnvironmentObservation;
  verification: VerificationResult;
  memories: Memory[];
  conversation?: readonly Message[];
  recentActions: WorkerAction[];
  failedStrategies: TaskState['failedStrategies'];
  execute: WorkerExecutionContext;
  maxActions: number;
  signal?: AbortSignal;
}

export interface WorkerProvider {
  execute(input: WorkerContext): Promise<WorkerResult>;
}

export interface RequestedToolEffect {
  tool: string;
  /** Number of successful calls to this tool needed for the requested result. */
  count?: number;
}

export interface ActingAgentContext {
  userMessage: string;
  conversation: readonly Message[];
  memories: readonly Memory[];
  toolDefinitions: readonly ToolDefinition[];
  executeTool(tool: string, input: Record<string, unknown>): Promise<ToolResult>;
  verifyCompletion(input: {
    response: string;
    requiredEffects: readonly RequestedToolEffect[];
  }): Promise<ToolResult<VerificationResult>>;
  drainSteering?: () => Message[];
  maxSteps: number;
  maxRepeatedAction: number;
  maxConsecutiveFailures: number;
  signal?: AbortSignal;
}

export interface ActingAgentResult {
  response: string;
  verification: VerificationResult;
}

/** One coherent model conversation with native, runtime-validated Helm tools. */
export interface ActingAgentProvider {
  execute(input: ActingAgentContext): Promise<ActingAgentResult>;
}

export interface DecisionProvider {
  next(input: AgentTurnContext): Promise<AgentDecision>;
}

export interface ObservationInput {
  task: TaskDefinition;
  completedCriteria: string[];
  remainingCriteria: string[];
  lastToolResult?: ToolResult;
  signal?: AbortSignal;
}

export interface ObservationProvider {
  observe(input: ObservationInput): Promise<EnvironmentObservation>;
}

export interface VerificationProvider {
  verifyTask(
    task: Pick<TaskDefinition, 'criteria'>,
    context?: {
      observation?: EnvironmentObservation;
      lastToolResult?: ToolResult;
      guest?: GuestTransport;
    },
  ): Promise<VerificationResult>;
}

export interface RuntimeRepository {
  createRun?(run: Run): Promise<void> | void;
  updateRun?(run: Run): Promise<void> | void;
  saveRun?(run: Run): Promise<void> | void;
  appendStep?(step: RunStep): Promise<void> | void;
  saveStep?(step: RunStep): Promise<void> | void;
}

export type AgentRuntimeRepository = RuntimeRepository;
export type RuntimePersistence = RuntimeRepository;

export type RuntimeEventType =
  | 'run.started'
  | 'run.step.started'
  | 'run.step.completed'
  | 'run.verification'
  | 'run.completed'
  | 'run.blocked'
  | 'run.failed'
  | 'run.cancelled';

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  runId: string;
  payload: unknown;
}

export interface RuntimeEventSink {
  emit?(event: RuntimeEvent): Promise<void> | void;
  publish?(event: RuntimeEvent): Promise<void> | void;
}

export type AgentRuntimeEventSink = RuntimeEventSink;

export interface RuntimeBudgets {
  maxSteps: number;
  maxRepeatedAction: number;
  maxConsecutiveFailures: number;
  toolTimeoutMs: number;
  maxWorkerActions: number;
  noProgressThreshold: number;
  maxRecoveryAttempts: number;
}

export interface AgentRuntimeOptions {
  guestTransport: GuestTransport;
  toolRegistry: ToolRegistry;
  verifier: CriterionVerifierRegistry | VerificationProvider;
  decisionProvider?: DecisionProvider;
  actingAgent?: ActingAgentProvider;
  taskPlanner?: TaskPlanner;
  taskCompiler?: TaskCompiler;
  orchestrator?: OrchestratorProvider;
  worker?: WorkerProvider;
  repository?: RuntimeRepository;
  persistence?: RuntimePersistence;
  events?: RuntimeEventSink;
  eventSink?: RuntimeEventSink;
  observe?: ObservationProvider;
  memories?: Memory[] | ((input: MemoryRecallInput) => Promise<Memory[]>);
  budgets?: Partial<RuntimeBudgets>;
  now?: () => number;
  idFactory?: (prefix: string) => string;
}

export interface RunTaskInput {
  threadId: string;
  userMessage: string;
  conversation?: readonly Message[];
  /**
   * Returns user steering messages that arrived while the run was active.
   * The runtime consumes them before its next decision so steering changes
   * the current run instead of starting an unrelated concurrent run.
   */
  drainSteering?: () => Message[];
  task?: TaskDefinition;
  runId?: string;
  sourceMessageId?: string;
  signal?: AbortSignal;
}

export interface AgentRuntimeResult {
  run: Run;
  task: TaskDefinition;
  history: AgentStep[];
  steps: RunStep[];
  observations: EnvironmentObservation[];
  finalVerification?: VerificationResult;
  /** The acting model's final reply, accepted after effect verification. */
  assistantResponse?: string;
  /** Convenience mirror for callers that do not unwrap `run`. */
  status: Run['status'];
}
