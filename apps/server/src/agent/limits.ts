import type { ToolResult } from '@helm/shared';

import type { RuntimeBudgets } from './types';

export const DEFAULT_RUNTIME_BUDGETS: RuntimeBudgets = {
  maxSteps: 32,
  maxRepeatedAction: 3,
  maxConsecutiveFailures: 3,
  toolTimeoutMs: 30_000,
  maxWorkerActions: 8,
  noProgressThreshold: 2,
  maxRecoveryAttempts: 2,
};

export interface BudgetSnapshot {
  steps: number;
  consecutiveFailures: number;
  maxSteps: number;
  maxConsecutiveFailures: number;
}

export class RunBudget {
  readonly maxSteps: number;
  readonly maxConsecutiveFailures: number;
  private stepCount = 0;
  private failureCount = 0;

  constructor(options: Partial<RuntimeBudgets> = {}) {
    const values = { ...DEFAULT_RUNTIME_BUDGETS, ...options };
    if (!Number.isInteger(values.maxSteps) || values.maxSteps < 1) throw new Error('maxSteps must be positive');
    if (!Number.isInteger(values.maxConsecutiveFailures) || values.maxConsecutiveFailures < 1) {
      throw new Error('maxConsecutiveFailures must be positive');
    }
    this.maxSteps = values.maxSteps;
    this.maxConsecutiveFailures = values.maxConsecutiveFailures;
  }

  get steps(): number {
    return this.stepCount;
  }

  get consecutiveFailures(): number {
    return this.failureCount;
  }

  canStartStep(): boolean {
    return this.stepCount < this.maxSteps;
  }

  startStep(): number {
    if (!this.canStartStep()) throw new Error('Step budget exceeded');
    const step = this.stepCount;
    this.stepCount += 1;
    return step;
  }

  recordToolResult(result: ToolResult): boolean {
    if (result.ok) this.failureCount = 0;
    else this.failureCount += 1;
    return this.failureCount >= this.maxConsecutiveFailures;
  }

  snapshot(): BudgetSnapshot {
    return {
      steps: this.stepCount,
      consecutiveFailures: this.failureCount,
      maxSteps: this.maxSteps,
      maxConsecutiveFailures: this.maxConsecutiveFailures,
    };
  }
}

export class RunCancellation {
  readonly controller = new AbortController();

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get cancelled(): boolean {
    return this.signal.aborted;
  }

  cancel(reason = 'Run cancelled'): void {
    if (!this.signal.aborted) this.controller.abort(reason);
  }

  throwIfCancelled(): void {
    if (this.signal.aborted) {
      throw new Error(typeof this.signal.reason === 'string' ? this.signal.reason : 'Run cancelled');
    }
  }
}

export const CancellationToken = RunCancellation;
