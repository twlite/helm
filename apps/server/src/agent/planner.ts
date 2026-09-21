import type {
  AgentDecision,
  AgentTurnContext,
  TaskDefinition,
  ToolResult,
} from '@helm/shared';

import type { DecisionProvider, TaskPlanner, TaskPlannerInput } from './types';

export type ScriptedTaskFactory =
  | TaskDefinition
  | ((input: TaskPlannerInput) => TaskDefinition | Promise<TaskDefinition>);

function clone<T>(value: T): T {
  return structuredClone(value);
}

function taskId(input: TaskPlannerInput): string {
  return `task-${input.threadId.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'scripted'}`;
}

export class ScriptedTaskPlanner implements TaskPlanner {
  private readonly factory: ScriptedTaskFactory;

  constructor(factory: ScriptedTaskFactory) {
    this.factory = factory;
  }

  async createTask(input: TaskPlannerInput): Promise<TaskDefinition> {
    const planned = typeof this.factory === 'function' ? await this.factory(input) : this.factory;
    return clone({
      ...planned,
      id: planned.id || taskId(input),
      threadId: input.threadId,
    });
  }
}

export interface PriorResultReference {
  /** One-based action step number, or `last` for the latest action result. */
  fromStep: number | 'last';
  /** Dot-separated path such as `data.text`; an empty path returns the result. */
  path?: string;
}

export type ScriptedDecision = AgentDecision & {
  type: 'action';
  input: Record<string, unknown>;
} | Exclude<AgentDecision, { type: 'action' }>;

export class PriorResultReferenceError extends Error {
  readonly reference: PriorResultReference;

  constructor(reference: PriorResultReference, message: string) {
    super(message);
    this.name = 'PriorResultReferenceError';
    this.reference = reference;
  }
}

function isReference(value: unknown): value is PriorResultReference {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fromStep' in value &&
    (typeof (value as { fromStep?: unknown }).fromStep === 'number' ||
      (value as { fromStep?: unknown }).fromStep === 'last') &&
    (('path' in value && typeof (value as { path?: unknown }).path === 'string') || !('path' in value))
  );
}

function pathValue(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const segment of path.split('.').filter(Boolean)) {
    if (current === null || current === undefined || !(segment in Object(current))) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function resolvePriorResultReference(
  reference: PriorResultReference,
  previousResults: readonly ToolResult[],
): unknown {
  const index = reference.fromStep === 'last' ? previousResults.length - 1 : reference.fromStep - 1;
  if (!Number.isInteger(index) || index < 0 || index >= previousResults.length) {
    throw new PriorResultReferenceError(
      reference,
      `No prior tool result exists for step ${String(reference.fromStep)}.`,
    );
  }
  const value = pathValue(previousResults[index], reference.path);
  if (value === undefined) {
    throw new PriorResultReferenceError(
      reference,
      `Prior tool result has no value at ${reference.path ?? '<root>'}.`,
    );
  }
  return clone(value);
}

export function resolvePriorResultReferences<T>(
  value: T,
  previousResults: readonly ToolResult[],
): T {
  if (isReference(value)) return resolvePriorResultReference(value, previousResults) as T;
  if (Array.isArray(value)) {
    return value.map(item => resolvePriorResultReferences(item, previousResults)) as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      result[key] = resolvePriorResultReferences(child, previousResults);
    }
    return result as T;
  }
  return value;
}

export class ScriptedDecisionProvider implements DecisionProvider {
  private readonly decisions: ScriptedDecision[];
  private cursor = 0;

  constructor(decisions: readonly ScriptedDecision[]) {
    this.decisions = decisions.map(decision => clone(decision));
  }

  get index(): number {
    return this.cursor;
  }

  get remaining(): number {
    return Math.max(0, this.decisions.length - this.cursor);
  }

  reset(): void {
    this.cursor = 0;
  }

  async next(input: AgentTurnContext): Promise<AgentDecision> {
    const decision = this.decisions[this.cursor];
    if (!decision) {
      return {
        type: 'blocked',
        reason: 'Scripted decision sequence is exhausted.',
        reasoningSummary: 'No scripted decision remains.',
      };
    }
    this.cursor += 1;
    if (decision.type !== 'action') return clone(decision);
    return {
      ...clone(decision),
      input: resolvePriorResultReferences(decision.input, input.previousResults),
    };
  }
}

export function isPriorResultReference(value: unknown): value is PriorResultReference {
  return isReference(value);
}
