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
  ToolError,
  ToolResult,
  VerificationResult,
} from '@helm/shared';

import { CriterionVerifierRegistry } from '../tools/criterion-verifier';
import type { GuestTransport } from '../tools/guest-transport';
import { ToolRegistry } from '../tools/tool-registry';
import { fingerprintAction, LoopDetector } from './fingerprint';
import { DEFAULT_RUNTIME_BUDGETS, RunBudget, RunCancellation } from './limits';
import { GuestObservationProvider } from './observation';
import type {
  AgentRuntimeOptions,
  AgentRuntimeResult,
  DecisionProvider,
  ObservationProvider,
  RunTaskInput,
  RuntimeEvent,
  RuntimeEventSink,
  RuntimeRepository,
  TaskPlanner,
  VerificationProvider,
} from './types';

function defaultIdFactory(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function isTaskDefinition(value: unknown): value is TaskDefinition {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'threadId' in value &&
    'goal' in value &&
    'criteria' in value &&
    Array.isArray((value as { criteria?: unknown }).criteria)
  );
}

function criterionKey(criterion: CompletionCriterion): string {
  return JSON.stringify(criterion);
}

function error(code: string, message: string): ToolError {
  return { code, message };
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function completionRejection(verification: VerificationResult): ToolResult {
  return {
    ok: false,
    error: {
      code: 'COMPLETION_REJECTED',
      message: `Completion rejected: ${verification.summary}`,
      details: verification.criteria.map(check => ({
        criterion: criterionKey(check.criterion),
        passed: check.passed,
        message: check.message,
      })),
    },
  };
}

function isVerificationProvider(value: CriterionVerifierRegistry | VerificationProvider): value is VerificationProvider {
  return typeof value.verifyTask === 'function';
}

export class AgentRuntime {
  private readonly guest: GuestTransport;
  private readonly tools: ToolRegistry;
  private readonly verifier: CriterionVerifierRegistry | VerificationProvider;
  private readonly decisionProvider: DecisionProvider;
  private readonly taskPlanner?: TaskPlanner;
  private readonly repository?: RuntimeRepository;
  private readonly eventSink?: RuntimeEventSink;
  private readonly observationProvider: ObservationProvider;
  private readonly memories?: AgentRuntimeOptions['memories'];
  private readonly budgetOptions: AgentRuntimeOptions['budgets'];
  private readonly now: () => number;
  private readonly idFactory: (prefix: string) => string;
  private activeCancellation?: RunCancellation;
  private activeRunId?: string;

  constructor(options: AgentRuntimeOptions) {
    this.guest = options.guestTransport;
    this.tools = options.toolRegistry;
    this.verifier = options.verifier;
    this.decisionProvider = options.decisionProvider;
    this.taskPlanner = options.taskPlanner;
    this.repository = options.repository ?? options.persistence;
    this.eventSink = options.events ?? options.eventSink;
    this.observationProvider = options.observe ?? new GuestObservationProvider({ guest: this.guest });
    this.memories = options.memories;
    this.budgetOptions = options.budgets;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  get running(): boolean {
    return this.activeCancellation !== undefined;
  }

  get currentRunId(): string | undefined {
    return this.activeRunId;
  }

  cancel(reason = 'Run cancelled'): boolean {
    if (!this.activeCancellation) return false;
    this.activeCancellation.cancel(reason);
    return true;
  }

  cancelRun(reason = 'Run cancelled'): boolean {
    return this.cancel(reason);
  }

  async run(task: TaskDefinition): Promise<AgentRuntimeResult>;
  async run(input: RunTaskInput): Promise<AgentRuntimeResult>;
  async run(taskOrInput: TaskDefinition | RunTaskInput): Promise<AgentRuntimeResult> {
    if (this.activeCancellation) throw new Error('AgentRuntime already has an active run');

    const input = isTaskDefinition(taskOrInput)
      ? { threadId: taskOrInput.threadId, userMessage: taskOrInput.goal, task: taskOrInput }
      : taskOrInput;
    const task = input.task ?? await this.createTask(input);
    const cancellation = new RunCancellation();
    const removeExternalAbort = this.attachExternalCancellation(cancellation, input.signal);
    this.activeCancellation = cancellation;
    const runId = input.runId ?? this.idFactory('run');
    this.activeRunId = runId;
    const startedAt = this.isoNow();
    const run: Run = {
      id: runId,
      threadId: task.threadId,
      ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
      goal: task.goal,
      status: 'pending',
      criteria: clone(task.criteria),
      createdAt: startedAt,
    };
    const history: AgentStep[] = [];
    const steps: RunStep[] = [];
    const observations: EnvironmentObservation[] = [];
    const previousResults: ToolResult[] = [];
    let finalVerification: VerificationResult | undefined;
    let completedCriteria: string[] = [];
    let remainingCriteria = task.criteria.map(criterionKey);
    let lastToolResult: ToolResult | undefined;
    const configuredMaxSteps = this.budgetOptions?.maxSteps ?? DEFAULT_RUNTIME_BUDGETS.maxSteps;
    const budget = new RunBudget({
      ...DEFAULT_RUNTIME_BUDGETS,
      ...this.budgetOptions,
      ...(task.maxSteps === undefined
        ? {}
        : { maxSteps: Math.min(configuredMaxSteps, task.maxSteps) }),
    });
    const loopDetector = new LoopDetector(this.budgetOptions?.maxRepeatedAction ?? DEFAULT_RUNTIME_BUDGETS.maxRepeatedAction);

    try {
      run.status = 'running';
      run.startedAt = startedAt;
      await this.persistRun(run, true);
      await this.emit('run.started', run, run.id);

      const memories = await this.loadMemories();
      while (!this.isTerminal(run.status)) {
        cancellation.throwIfCancelled();
        if (!budget.canStartStep()) {
          await this.fail(run, error('STEP_BUDGET_EXCEEDED', `Run exceeded its ${budget.maxSteps}-step budget.`));
          break;
        }
        const stepIndex = budget.startStep();
        const observation = await this.observationProvider.observe({
          task,
          completedCriteria,
          remainingCriteria,
          lastToolResult,
          signal: cancellation.signal,
        });
        observations.push(clone(observation));
        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'observe',
          observation,
        });

        await this.emit('run.step.started', { stepIndex, observation }, run.id);
        const context: AgentTurnContext = {
          task,
          observation,
          history: clone(history),
          memories: clone(memories),
          stepIndex,
          previousResults: clone(previousResults),
        };
        const decision = await this.decisionProvider.next(context);
        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'reason',
          decision,
          observation,
        });

        if (decision.type === 'blocked') {
          const entry: AgentStep = {
            reasoningSummary: decision.reasoningSummary,
            observation,
          };
          history.push(entry);
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'blocked',
            decision,
            observation,
          });
          await this.block(run, error('DECISION_BLOCKED', decision.reason));
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

        if (decision.type === 'complete') {
          const verification = await this.verify(task, observation, lastToolResult);
          finalVerification = verification;
          const entry: AgentStep = {
            reasoningSummary: decision.reasoningSummary,
            observation,
            verification,
          };
          history.push(entry);
          completedCriteria = verification.criteria.filter(check => check.passed).map(check => criterionKey(check.criterion));
          remainingCriteria = verification.criteria.filter(check => !check.passed).map(check => criterionKey(check.criterion));
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'complete',
            decision,
            observation,
            verification,
          });
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'verify',
            decision,
            observation,
            verification,
          });
          await this.emit('run.verification', verification, run.id);
          if (verification.complete) {
            await this.complete(run, verification);
          } else {
            lastToolResult = completionRejection(verification);
          }
          await this.emit('run.step.completed', entry, run.id);
          continue;
        }

        const entry: AgentStep = {
          reasoningSummary: decision.reasoningSummary,
          action: { tool: decision.tool, input: clone(decision.input) },
          observation,
        };
        const result = await this.tools.execute(decision.tool, decision.input, {
          signal: cancellation.signal,
          runId: run.id,
          stepIndex,
          previousResults,
          timeoutMs: this.budgetOptions?.toolTimeoutMs,
        });
        previousResults.push(clone(result));
        lastToolResult = result;
        const postActionObservation = await this.observationProvider.observe({
          task,
          completedCriteria,
          remainingCriteria,
          lastToolResult: result,
          signal: cancellation.signal,
        });
        const verification = await this.verify(task, postActionObservation, result);
        finalVerification = verification;
        entry.observation = postActionObservation;
        entry.verification = verification;
        history.push(entry);
        completedCriteria = verification.criteria.filter(check => check.passed).map(check => criterionKey(check.criterion));
        remainingCriteria = verification.criteria.filter(check => !check.passed).map(check => criterionKey(check.criterion));

        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'act',
          decision,
          toolName: decision.tool,
          toolInput: decision.input,
          toolResult: result,
          observation: postActionObservation,
        });
        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'verify',
          decision,
          toolName: decision.tool,
          toolInput: decision.input,
          toolResult: result,
          observation: postActionObservation,
          verification,
        });
        await this.emit('run.verification', verification, run.id);

        const loop = loopDetector.record(fingerprintAction(
          decision.tool,
          decision.input,
          postActionObservation,
          result,
        ));
        if (loop.loopDetected) {
          await this.fail(
            run,
            error(
              'TOOL_LOOP_DETECTED',
              `The same action produced the same state ${loop.count} times.`,
            ),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }
        if (budget.recordToolResult(result)) {
          await this.fail(
            run,
            error(
              'TOOL_FAILURE_LIMIT',
              `Run reached ${budget.maxConsecutiveFailures} consecutive tool failures.`,
            ),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }
        await this.emit('run.step.completed', entry, run.id);
      }
    } catch (caught) {
      if (cancellation.cancelled || input.signal?.aborted) {
        await this.cancelled(run, error('RUN_CANCELLED', 'Run was cancelled.'));
      } else if (!this.isTerminal(run.status)) {
        await this.fail(run, error('RUNTIME_ERROR', errorMessage(caught)));
      }
    } finally {
      removeExternalAbort();
      this.activeCancellation = undefined;
      this.activeRunId = undefined;
    }

    return {
      run: clone(run),
      task: clone(task),
      history: clone(history),
      steps: clone(steps),
      observations: clone(observations),
      finalVerification: finalVerification ? clone(finalVerification) : undefined,
      status: run.status,
    };
  }

  async runTask(input: RunTaskInput): Promise<AgentRuntimeResult> {
    return this.run(input);
  }

  private async createTask(input: RunTaskInput): Promise<TaskDefinition> {
    if (!this.taskPlanner) throw new Error('A task planner is required when no task is supplied');
    return this.taskPlanner.createTask({ threadId: input.threadId, userMessage: input.userMessage });
  }

  private async loadMemories(): Promise<Memory[]> {
    if (!this.memories) return [];
    return clone(typeof this.memories === 'function' ? await this.memories() : this.memories);
  }

  private async verify(
    task: TaskDefinition,
    observation: EnvironmentObservation,
    lastToolResult?: ToolResult,
  ): Promise<VerificationResult> {
    return this.verifier.verifyTask(task, {
      guest: this.guest,
      observation,
      lastToolResult,
    });
  }

  private async persistRun(run: Run, initial = false): Promise<void> {
    if (!this.repository) return;
    if (this.repository.saveRun) await this.repository.saveRun(clone(run));
    else if (initial) await this.repository.createRun?.(clone(run));
    else await this.repository.updateRun?.(clone(run));
  }

  private async persistStep(steps: RunStep[], input: Omit<RunStep, 'id' | 'createdAt'>): Promise<void> {
    const now = this.isoNow();
    const step: RunStep = { ...input, id: this.idFactory('step'), createdAt: now, completedAt: now };
    steps.push(clone(step));
    if (this.repository?.saveStep) await this.repository.saveStep(clone(step));
    else await this.repository?.appendStep?.(clone(step));
  }

  private async emit(type: RuntimeEvent['type'], payload: unknown, runId: string): Promise<void> {
    if (!this.eventSink) return;
    const event: RuntimeEvent = {
      type,
      timestamp: this.isoNow(),
      runId,
      payload: clone(payload),
    };
    if (this.eventSink.emit) await this.eventSink.emit(event);
    else await this.eventSink.publish?.(event);
  }

  private async complete(run: Run, verification: VerificationResult): Promise<void> {
    run.status = 'completed';
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.completed', verification, run.id);
  }

  private async block(run: Run, runError: ToolError): Promise<void> {
    run.status = 'blocked';
    run.error = runError;
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.blocked', runError, run.id);
  }

  private async fail(run: Run, runError: ToolError): Promise<void> {
    run.status = 'failed';
    run.error = runError;
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.failed', runError, run.id);
  }

  private async cancelled(run: Run, runError: ToolError): Promise<void> {
    run.status = 'cancelled';
    run.error = runError;
    run.completedAt = this.isoNow();
    await this.persistRun(run);
    await this.emit('run.cancelled', runError, run.id);
  }

  private isTerminal(status: Run['status']): boolean {
    return status === 'blocked' || status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private attachExternalCancellation(
    cancellation: RunCancellation,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) return () => undefined;
    const onAbort = () => cancellation.cancel();
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }
}

export type Runtime = AgentRuntime;
