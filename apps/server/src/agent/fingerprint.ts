import type { ToolResult } from '@helm/shared';

function normalized(value: unknown): unknown {
  if (value === undefined) return '[undefined]';
  if (typeof value === 'number' && Number.isNaN(value)) return '[nan]';
  if (typeof value === 'number' && !Number.isFinite(value)) return `[${String(value)}]`;
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalized(child)]),
    );
  }
  return value;
}

function withoutVolatileObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutVolatileObservation);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'timestamp' && key !== 'createdAt' && key !== 'completedAt')
        .map(([key, child]) => [key, withoutVolatileObservation(child)]),
    );
  }
  return value;
}

export function normalizeForFingerprint(value: unknown): unknown {
  return normalized(value);
}

export function fingerprintAction(
  tool: string,
  input: unknown,
  relevantObservation?: unknown,
  result?: ToolResult,
): string {
  return JSON.stringify(
    normalized({
      tool,
      input,
      relevantObservation: withoutVolatileObservation(relevantObservation),
      result: result ? { ok: result.ok, data: result.data, error: result.error } : undefined,
    }),
  );
}

export interface LoopRecord {
  fingerprint: string;
  count: number;
  loopDetected: boolean;
}

/** Counts identical action/result/state fingerprints for one run. */
export class LoopDetector {
  private readonly counts = new Map<string, number>();
  private readonly threshold: number;

  constructor(maxRepeatedAction = 3) {
    if (!Number.isInteger(maxRepeatedAction) || maxRepeatedAction < 1) {
      throw new Error('maxRepeatedAction must be a positive integer');
    }
    this.threshold = maxRepeatedAction;
  }

  record(fingerprint: string): LoopRecord {
    const count = (this.counts.get(fingerprint) ?? 0) + 1;
    this.counts.set(fingerprint, count);
    return { fingerprint, count, loopDetected: count >= this.threshold };
  }

  recordAction(tool: string, input: unknown, observation?: unknown, result?: ToolResult): LoopRecord {
    return this.record(fingerprintAction(tool, input, observation, result));
  }

  count(fingerprint: string): number {
    return this.counts.get(fingerprint) ?? 0;
  }

  reset(): void {
    this.counts.clear();
  }
}

export const actionFingerprint = fingerprintAction;
