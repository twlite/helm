import type {
  AgentDecision,
  AgentStep,
  AgentTurnContext,
  CompletionCriterion,
  EnvironmentObservation,
  Memory,
  Run,
  RunStep,
  TaskDefinition,
  ToolResult,
  VerificationResult,
} from '@helm/shared';

import type { GuestTransport } from '../tools/guest-transport';
import type { ToolRegistry } from '../tools/tool-registry';
import type { CriterionVerifierRegistry } from '../tools/criterion-verifier';

export type {
  AgentDecision,
  AgentStep,
  AgentTurnContext,
  CompletionCriterion,
  EnvironmentObservation,
  Memory,
  Run,
  RunStep,
  TaskDefinition,
  ToolResult,
  VerificationResult,
};

export interface TaskPlannerInput {
  threadId: string;
  userMessage: string;
}

export interface TaskPlanner {
  createTask(input: TaskPlannerInput): Promise<TaskDefinition>;
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
}

export interface AgentRuntimeOptions {
  guestTransport: GuestTransport;
  toolRegistry: ToolRegistry;
  verifier: CriterionVerifierRegistry | VerificationProvider;
  decisionProvider: DecisionProvider;
  taskPlanner?: TaskPlanner;
  repository?: RuntimeRepository;
  persistence?: RuntimePersistence;
  events?: RuntimeEventSink;
  eventSink?: RuntimeEventSink;
  observe?: ObservationProvider;
  memories?: Memory[] | (() => Promise<Memory[]>);
  budgets?: Partial<RuntimeBudgets>;
  now?: () => number;
  idFactory?: (prefix: string) => string;
}

export interface RunTaskInput {
  threadId: string;
  userMessage: string;
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
  /** Convenience mirror for callers that do not unwrap `run`. */
  status: Run['status'];
}
