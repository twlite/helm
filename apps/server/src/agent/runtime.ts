import { browserUrlsMatch } from '@helm/shared';
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
import {
  BROWSER_RESEARCH_CRITERION_ID,
  isBrowserResearchRequest,
  isSameSearchNavigation,
  isSearchResultsUrl,
} from './browser-research';
import { fingerprintAction, LoopDetector } from './fingerprint';
import { DEFAULT_RUNTIME_BUDGETS, RunBudget, RunCancellation } from './limits';
import { GuestObservationProvider } from './observation';
import type {
  AgentRuntimeOptions,
  AgentRuntimeResult,
  DecisionProvider,
  MemoryRecallInput,
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

function taskRequiresPageContent(task: TaskDefinition, userMessage = ''): boolean {
  if (task.criteria.some(criterion => criterion.type === 'custom' && criterion.id === BROWSER_RESEARCH_CRITERION_ID)) {
    return true;
  }
  const goal = `${task.goal}\n${userMessage}`.toLowerCase();
  if (isBrowserResearchRequest(goal)) return true;
  const referencesWebContent = /\b(page|site|website|web|profile|url|browser|github|http)\b/u.test(goal);
  const requestsContent = /\b(read|extract|tell|summari[sz]e|report|content|information|details|what)\b/u.test(goal);
  return referencesWebContent && requestsContent;
}

function canExtractOpenPage(observation: EnvironmentObservation, lastToolResult?: ToolResult): boolean {
  if (!observation.browser?.url || observation.browser.url === 'about:blank') return false;
  if (!/^https?:\/\//iu.test(observation.browser.url)) return false;
  return lastToolResult?.ok === true || observation.browser.loaded === true;
}

function hasReadableCurrentPage(
  observation: EnvironmentObservation,
  pageContentRead: boolean,
  pageContentUrl: string | undefined,
): boolean {
  if (!pageContentRead || !pageContentUrl || !observation.browser?.url) return false;
  return browserUrlsMatch(pageContentUrl, observation.browser.url);
}

function toolResultUrl(result: ToolResult | undefined): string | undefined {
  if (!result?.ok || typeof result.data !== 'object' || result.data === null || Array.isArray(result.data)) {
    return undefined;
  }
  const url = (result.data as Record<string, unknown>).url;
  return typeof url === 'string' ? url : undefined;
}

/**
 * A search-capable model can keep navigating to the already-loaded results
 * page, or bounce between a search URL and the search-engine home page, when
 * it has not been shown any page content yet. Turn that no-progress decision
 * into an inspection operation. This keeps the model in control of choosing
 * the next result while preventing another search cycle from consuming steps.
 */
function shouldInspectRepeatedBrowserNavigation(
  decision: AgentDecision,
  observation: EnvironmentObservation,
  history: readonly AgentStep[],
  lastToolResult: ToolResult | undefined,
  pageContentRequired: boolean,
  inspectedBrowserUrls: ReadonlySet<string>,
): 'browser.extractText' | 'browser.snapshot' | undefined {
  if (
    !pageContentRequired
    || decision.type !== 'action'
    || decision.tool !== 'browser.navigate'
  ) {
    return undefined;
  }

  const targetUrl = typeof decision.input.url === 'string' ? decision.input.url : undefined;
  const currentUrl = observation.browser?.url ?? toolResultUrl(lastToolResult);
  if (!targetUrl || !currentUrl || currentUrl === 'about:blank') return undefined;

  const lastStep = history[history.length - 1];
  const repeatedCurrentPage = (
    lastStep?.action?.tool === 'browser.navigate'
    && lastToolResult?.ok === true
    && browserUrlsMatch(currentUrl, targetUrl)
  );
  const returningToSearchPage = isSearchResultsUrl(currentUrl) && isSameSearchNavigation(currentUrl, targetUrl);
  if (!repeatedCurrentPage && !returningToSearchPage) return undefined;

  const inspected = [...inspectedBrowserUrls].some(url => browserUrlsMatch(url, currentUrl));
  return inspected ? 'browser.snapshot' : 'browser.extractText';
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
    const memories = await this.loadMemories({
      threadId: input.threadId,
      userMessage: input.userMessage,
      signal: input.signal,
    });
    // Keep a mutable per-run conversation window. The server can inject
    // steering messages between tool turns without changing the persisted
    // thread or starting a second runtime against the same desktop.
    const conversation = [...(input.conversation ?? [])];
    const task = input.task ?? await this.createTask(input, memories);
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
    const inspectedBrowserUrls = new Set<string>();
    let finalVerification: VerificationResult | undefined;
    let completedCriteria: string[] = [];
    let remainingCriteria = task.criteria.map(criterionKey);
    let lastToolResult: ToolResult | undefined;
    let completionCandidate: {
      actionFingerprint: string;
      verification: VerificationResult;
    } | undefined;
    const pageContentRequired = taskRequiresPageContent(task, input.userMessage);
    const conversationalTask = task.criteria.length === 0;
    let pageContentRead = false;
    let pageContentUrl: string | undefined;
    let prematureCompletionAttempts = 0;
    let rejectedCompletionAttempts = 0;
    const configuredMaxSteps = this.budgetOptions?.maxSteps ?? DEFAULT_RUNTIME_BUDGETS.maxSteps;
    const budget = new RunBudget({
      ...DEFAULT_RUNTIME_BUDGETS,
      ...this.budgetOptions,
      ...(task.maxSteps === undefined
        ? {}
        : { maxSteps: Math.min(configuredMaxSteps, task.maxSteps) }),
    });
    const maxRepeatedAction = this.budgetOptions?.maxRepeatedAction ?? DEFAULT_RUNTIME_BUDGETS.maxRepeatedAction;
    const actionLoopDetector = new LoopDetector(maxRepeatedAction);
    const stateLoopDetector = new LoopDetector(maxRepeatedAction);

    try {
      run.status = 'running';
      run.startedAt = startedAt;
      await this.persistRun(run, true);
      await this.emit('run.started', run, run.id);

      while (!this.isTerminal(run.status)) {
        cancellation.throwIfCancelled();
        const steering = input.drainSteering?.() ?? [];
        if (steering.length > 0) {
          conversation.push(...steering.map(message => clone(message)));
        }
        if (!budget.canStartStep()) {
          await this.fail(run, error('STEP_BUDGET_EXCEEDED', `Run exceeded its ${budget.maxSteps}-step budget.`));
          break;
        }
        const stepIndex = budget.startStep();
        const observation: EnvironmentObservation = conversationalTask
          ? {
            timestamp: this.now(),
            ...(lastToolResult ? { lastToolResult } : {}),
            task: {
              completedCriteria: [],
              remainingCriteria: [],
            },
          }
          : await this.observationProvider.observe({
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
          conversation: clone(conversation),
          stepIndex,
          previousResults: clone(previousResults),
          signal: cancellation.signal,
        };
        let decision: AgentDecision = conversationalTask
          ? { type: 'complete', reasoningSummary: 'Responding to the conversation.' }
          : await this.decisionProvider.next(context);

        // A page-information task must return page contents, even when the
        // model incorrectly asks to complete immediately after navigation.
        // Turn that premature completion into the one safe, deterministic
        // read operation the user asked for; the normal tool/verification
        // path still records and bounds the operation.
        if (
          !conversationalTask
          && pageContentRequired
          && !hasReadableCurrentPage(observation, pageContentRead, pageContentUrl)
          && decision.type === 'complete'
          && canExtractOpenPage(observation, lastToolResult)
        ) {
          decision = {
            type: 'action',
            tool: 'browser.extractText',
            input: {},
            reasoningSummary: 'Reading the open page before answering.',
          };
        }

        const repeatedInspectionTool = shouldInspectRepeatedBrowserNavigation(
          decision,
          observation,
          history,
          lastToolResult,
          pageContentRequired,
          inspectedBrowserUrls,
        );
        if (repeatedInspectionTool !== undefined) {
          decision = {
            type: 'action',
            tool: repeatedInspectionTool,
            input: {},
            reasoningSummary: repeatedInspectionTool === 'browser.snapshot'
              ? 'Inspecting the loaded search results for a relevant source link.'
              : 'Reading the loaded search results before choosing a source page.',
          };
        }

        // Give the model one final turn after a successful action, but do not
        // execute the same already-verified action again if it repeats it.
        if (
          completionCandidate &&
          decision.type === 'action' &&
          (!pageContentRequired || hasReadableCurrentPage(observation, pageContentRead, pageContentUrl)) &&
          fingerprintAction(decision.tool, decision.input) === completionCandidate.actionFingerprint
        ) {
          await this.complete(run, completionCandidate.verification);
          await this.emit('run.step.completed', {
            observation,
            verification: completionCandidate.verification,
          }, run.id);
          break;
        }
        if (
          completionCandidate
          && decision.type === 'blocked'
          && (!pageContentRequired || hasReadableCurrentPage(observation, pageContentRead, pageContentUrl))
        ) {
          await this.complete(run, completionCandidate.verification);
          await this.emit('run.step.completed', {
            observation,
            verification: completionCandidate.verification,
          }, run.id);
          break;
        }

        await this.persistStep(steps, {
          runId: run.id,
          stepIndex,
          phase: 'reason',
          decision,
          observation,
        });

        // A conversational plan has no machine-verifiable criteria and must
        // never execute a computer-use action accidentally. The final answer
        // is generated from the thread conversation after the run completes.
        if (conversationalTask && decision.type === 'action') {
          const entry: AgentStep = {
            reasoningSummary: decision.reasoningSummary,
            observation,
          };
          history.push(entry);
          finalVerification = {
            complete: true,
            criteria: [],
            summary: 'Response ready.',
          };
          await this.persistStep(steps, {
            runId: run.id,
            stepIndex,
            phase: 'complete',
            decision: { type: 'complete', reasoningSummary: decision.reasoningSummary },
            observation,
            verification: finalVerification,
          });
          await this.emit('run.verification', finalVerification, run.id);
          await this.complete(run, finalVerification);
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

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
          let verification = conversationalTask
            ? { complete: true, criteria: [], summary: 'Response ready.' }
            : await this.verify(task, observation, lastToolResult);
          if (
            !conversationalTask
            && verification.complete
            && pageContentRequired
            && !hasReadableCurrentPage(observation, pageContentRead, pageContentUrl)
          ) {
            prematureCompletionAttempts += 1;
            verification = {
              ...verification,
              complete: false,
              summary: 'The page is open, but its contents have not been read yet. Read the page before completing.',
            };
          }
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
            completionCandidate = undefined;
            rejectedCompletionAttempts += 1;
            if (rejectedCompletionAttempts >= maxRepeatedAction) {
              await this.fail(
                run,
                error(
                  'COMPLETION_REJECTED',
                  `Helm stopped after ${rejectedCompletionAttempts} completion attempts while verification was still incomplete.`,
                ),
              );
              await this.emit('run.step.completed', entry, run.id);
              break;
            }
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
        rejectedCompletionAttempts = 0;
        previousResults.push(clone(result));
        lastToolResult = result;
        if (decision.tool === 'browser.navigate' && result.ok) {
          pageContentRead = false;
          pageContentUrl = undefined;
        }
        if (decision.tool === 'browser.extractText' && result.ok) {
          pageContentRead = true;
          pageContentUrl = toolResultUrl(result);
          prematureCompletionAttempts = 0;
        }
        const postActionObservation = await this.observationProvider.observe({
          task,
          completedCriteria,
          remainingCriteria,
          lastToolResult: result,
          signal: cancellation.signal,
        });
        if (result.ok && (decision.tool === 'browser.extractText' || decision.tool === 'browser.snapshot')) {
          const inspectedUrl = toolResultUrl(result) ?? postActionObservation.browser?.url;
          if (inspectedUrl) inspectedBrowserUrls.add(inspectedUrl);
        }
        if (decision.tool === 'browser.extractText' && result.ok && pageContentUrl === undefined) {
          pageContentUrl = postActionObservation.browser?.url;
        }
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

        if (
          pageContentRequired
          && !hasReadableCurrentPage(postActionObservation, pageContentRead, pageContentUrl)
          && prematureCompletionAttempts >= maxRepeatedAction
        ) {
          await this.fail(
            run,
            error('PAGE_CONTENT_NOT_READ', 'Helm could not complete the task because the requested page contents were not read.'),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

        if (verification.complete && result.ok) {
          if (
            pageContentRequired
            && !hasReadableCurrentPage(postActionObservation, pageContentRead, pageContentUrl)
          ) {
            const repeatedCompletedAction = actionLoopDetector.record(fingerprintAction(
              decision.tool,
              decision.input,
            ));
            if (repeatedCompletedAction.loopDetected) {
              await this.fail(
                run,
                error(
                  'TOOL_LOOP_DETECTED',
                  `Helm stopped after repeating ${decision.tool} ${repeatedCompletedAction.count} times without reading the requested page contents.`,
                ),
              );
              await this.emit('run.step.completed', entry, run.id);
              break;
            }
            await this.emit('run.step.completed', entry, run.id);
            continue;
          }

          completionCandidate = {
            actionFingerprint: fingerprintAction(decision.tool, decision.input),
            verification,
          };
          await this.emit('run.step.completed', entry, run.id);
          continue;
        }

        completionCandidate = undefined;

        // Detect an identical tool call independently from the observation.
        // Browser state can legitimately change between reads (loading flags,
        // window focus, and screenshot IDs), but repeating the same call with
        // the same input is still a reliable signal that the model is stuck.
        const repeatedAction = actionLoopDetector.record(fingerprintAction(
          decision.tool,
          decision.input,
        ));
        if (repeatedAction.loopDetected) {
          await this.fail(
            run,
            error(
              'TOOL_LOOP_DETECTED',
              `Helm stopped after repeating ${decision.tool} ${repeatedAction.count} times without making progress.`,
            ),
          );
          await this.emit('run.step.completed', entry, run.id);
          break;
        }

        const repeatedState = stateLoopDetector.record(fingerprintAction(
          decision.tool,
          decision.input,
          postActionObservation,
          result,
        ));
        if (repeatedState.loopDetected) {
          await this.fail(
            run,
            error(
              'TOOL_LOOP_DETECTED',
              `The same action produced the same state ${repeatedState.count} times.`,
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

  private async createTask(input: RunTaskInput, memories: Memory[]): Promise<TaskDefinition> {
    if (!this.taskPlanner) throw new Error('A task planner is required when no task is supplied');
    return this.taskPlanner.createTask({
      threadId: input.threadId,
      userMessage: input.userMessage,
      conversation: clone(input.conversation ?? []),
      memories: clone(memories),
      signal: input.signal,
    });
  }

  private async loadMemories(input: MemoryRecallInput): Promise<Memory[]> {
    if (!this.memories) return [];
    try {
      return clone(typeof this.memories === 'function' ? await this.memories(input) : this.memories);
    } catch {
      // Memory is best-effort context. A retrieval failure must not prevent a
      // valid task from being planned or executed.
      return [];
    }
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
