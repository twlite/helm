/** Inputs may be regular arrays or typed arrays returned by embedding providers. */
export type NumericVector = ArrayLike<number>;

export interface MemoryRelevanceWeights {
  semantic: number;
  recency: number;
  importance: number;
}

export const DEFAULT_MEMORY_RELEVANCE_WEIGHTS: Readonly<MemoryRelevanceWeights> = Object.freeze({
  semantic: 0.7,
  recency: 0.2,
  importance: 0.1,
});

export const DEFAULT_MEMORY_RECENCY_LAMBDA = 0.03;

export interface RecencyScoreOptions {
  /** Exponential decay per day; zero disables recency decay. */
  lambda?: number;
  /** Clock override in milliseconds since epoch, useful for deterministic ranking. */
  now?: Date | number;
}

export interface MemoryRelevanceOptions extends RecencyScoreOptions {
  weights?: Partial<MemoryRelevanceWeights>;
}

export interface MemoryRelevanceInput {
  embedding: NumericVector;
  createdAt: Date | number | string;
  importance?: number;
}

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Full cosine similarity. Empty and zero-norm vectors have no direction and score zero. */
export function cosineSimilarity(a: NumericVector, b: NumericVector): number {
  if (a.length !== b.length) {
    throw new RangeError(`Vector dimensions must match; received ${a.length} and ${b.length}`);
  }
  if (a.length === 0) return 0;

  // Scaling first avoids overflow for large finite inputs without assuming that
  // embeddings have already been normalized.
  let maxA = 0;
  let maxB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const valueA = a[index];
    const valueB = b[index];
    if (!Number.isFinite(valueA) || !Number.isFinite(valueB)) {
      throw new TypeError('Vectors must contain finite numbers');
    }
    maxA = Math.max(maxA, Math.abs(valueA));
    maxB = Math.max(maxB, Math.abs(valueB));
  }
  if (maxA === 0 || maxB === 0) return 0;

  let dot = 0;
  let normASquared = 0;
  let normBSquared = 0;
  for (let index = 0; index < a.length; index += 1) {
    const valueA = a[index] / maxA;
    const valueB = b[index] / maxB;
    dot += valueA * valueB;
    normASquared += valueA * valueA;
    normBSquared += valueB * valueB;
  }
  return dot / (Math.sqrt(normASquared) * Math.sqrt(normBSquared));
}

function epochMilliseconds(value: Date | number): number {
  const timestamp = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(timestamp)) throw new RangeError('Timestamp must be a valid date or epoch millisecond value');
  return timestamp;
}

/** Exponential age decay with future creation times treated as age zero. */
export function recencyScore(createdAt: Date | number, options: RecencyScoreOptions = {}): number {
  const createdAtMs = epochMilliseconds(createdAt);
  const nowMs = epochMilliseconds(options.now ?? Date.now());
  const lambda = options.lambda ?? DEFAULT_MEMORY_RECENCY_LAMBDA;
  if (!Number.isFinite(lambda) || lambda < 0) throw new RangeError('lambda must be a non-negative finite number');
  const ageInDays = Math.max(0, (nowMs - createdAtMs) / MILLISECONDS_PER_DAY);
  return Math.exp(-lambda * ageInDays);
}

function normalizedImportance(importance: number | undefined): number {
  if (importance === undefined || Number.isNaN(importance)) return 0.5;
  return Math.min(1, Math.max(0, importance));
}

function resolveWeights(weights: Partial<MemoryRelevanceWeights> | undefined): MemoryRelevanceWeights {
  const resolved = {
    semantic: weights?.semantic ?? DEFAULT_MEMORY_RELEVANCE_WEIGHTS.semantic,
    recency: weights?.recency ?? DEFAULT_MEMORY_RELEVANCE_WEIGHTS.recency,
    importance: weights?.importance ?? DEFAULT_MEMORY_RELEVANCE_WEIGHTS.importance,
  };
  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} weight must be a non-negative finite number`);
  }
  return resolved;
}

/**
 * A configurable weighted heuristic for ranking a memory against a query.
 * Defaults implement 0.70*cosine + 0.20*recency + 0.10*importance.
 */
export function calculateMemoryRelevance(
  queryEmbedding: NumericVector,
  memory: MemoryRelevanceInput,
  options: MemoryRelevanceOptions = {},
): number {
  const createdAt = memory.createdAt instanceof Date || typeof memory.createdAt === 'number'
    ? memory.createdAt
    : Date.parse(memory.createdAt);
  const weights = resolveWeights(options.weights);
  return weights.semantic * cosineSimilarity(queryEmbedding, memory.embedding)
    + weights.recency * recencyScore(createdAt, options)
    + weights.importance * normalizedImportance(memory.importance);
}
