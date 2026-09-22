import type {
  EnvironmentObservation,
  OrchestratorDecision,
  TaskRequirement,
  TaskState,
  WorkerAction,
  WorkerKind,
  WorkerObjective,
  WorkerResult,
} from '@helm/shared';

import type { OrchestratorContext, OrchestratorProvider, WorkerContext, WorkerProvider } from './types';
import { requirementsForTask } from './task-state';

function workerKind(requirement: TaskRequirement): WorkerKind {
  if (requirement.type === 'browser' || requirement.type === 'artifact') return 'browser';
  if (requirement.type === 'desktop') return 'desktop';
  if (requirement.type === 'filesystem') return 'filesystem';
  if (requirement.type === 'fact') {
    // Facts from a live page need semantic browser access. Runtime-seeded
    // system facts (for example the current date) do not need a worker.
    return requirement.id === 'currentDate' ? 'system' : 'browser';
  }
  return 'system';
}

/** Pick one small unmet requirement without turning the request into a fixed plan. */
export function objectiveForRequirement(
  state: TaskState,
  observation: EnvironmentObservation,
  requirementId: string,
): WorkerObjective | undefined {
  const requirements = requirementsForTask(state.task);
  const pending = requirements.find(requirement => requirement.id === requirementId && !state.completedRequirementIds.includes(requirement.id));
  if (!pending) return undefined;
  const target = pending.target;
  const facts = target?.factIds?.length ? ` using facts ${target.factIds.join(', ')}` : '';
  const path = target?.path ? ` at ${target.path}` : '';
  const location = observation.browser?.url ? ` Current page: ${observation.browser.url}.` : '';
  return {
    id: `objective-${pending.id}-${state.progress.recoveryAttempts}`,
    kind: workerKind(pending),
    description: `${pending.description}${path}${facts}.${location}`,
    requirementIds: [pending.id],
    rationale: state.progress.recoveryActive
      ? 'The previous strategy made no meaningful progress; choose a materially different action sequence.'
      : 'This is the next unmet mandatory requirement in the compiled task state.',
    ...(state.progress.recoveryActive ? { recovery: true } : {}),
  };
}

export function fallbackObjective(state: TaskState, observation: EnvironmentObservation): WorkerObjective | undefined {
  const pending = requirementsForTask(state.task).find(requirement => !state.completedRequirementIds.includes(requirement.id));
  return pending ? objectiveForRequirement(state, observation, pending.id) : undefined;
}

export class FallbackOrchestrator implements OrchestratorProvider {
  async next(input: OrchestratorContext): Promise<OrchestratorDecision> {
    const objective = fallbackObjective(input.state, input.observation);
    return objective
      ? { type: 'objective', objective, reasoningSummary: objective.rationale }
      : { type: 'complete', reasoningSummary: 'No unmet requirements remain in the compiled state.' };
  }
}

export class ScriptedOrchestratorProvider implements OrchestratorProvider {
  private readonly decisions: OrchestratorDecision[];
  private index = 0;

  constructor(decisions: readonly OrchestratorDecision[]) {
    this.decisions = [...decisions];
  }

  async next(input: OrchestratorContext): Promise<OrchestratorDecision> {
    const decision = this.decisions[Math.min(this.index, this.decisions.length - 1)];
    this.index += 1;
    if (decision) return decision;
    return new FallbackOrchestrator().next(input);
  }
}

export function allowedWorkerTool(kind: WorkerKind, tool: string): boolean {
  if (kind === 'browser') return tool.startsWith('browser.');
  if (kind === 'filesystem') return tool.startsWith('fs.');
  if (kind === 'desktop') return tool.startsWith('desktop.') || tool.startsWith('app.');
  return tool.startsWith('browser.') || tool.startsWith('fs.') || tool.startsWith('desktop.') || tool.startsWith('app.');
}

export class ScriptedWorkerProvider implements WorkerProvider {
  private readonly results: WorkerResult[];
  private index = 0;

  constructor(results: readonly WorkerResult[]) {
    this.results = [...results];
  }

  async execute(input: WorkerContext): Promise<WorkerResult> {
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index += 1;
    if (result) return result;
    return {
      status: 'blocked',
      worker: input.objective.kind,
      objectiveId: input.objective.id,
      actions: [],
      facts: [],
      evidence: [],
      artifacts: [],
      blockers: [{
        code: 'NO_SCRIPTED_RESULT',
        message: 'The scripted worker has no result for this objective.',
        requirementIds: input.objective.requirementIds,
      }],
      environmentChanged: false,
    };
  }
}

export function workerAction(
  id: string,
  tool: string,
  input: Record<string, unknown>,
  result: WorkerAction['result'],
): WorkerAction {
  return { id, tool, input, result };
}
