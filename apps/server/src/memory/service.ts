import type { JsonObject, Memory, MemorySource } from '@helm/shared';

import {
  MemoryRepository,
  type CreateMemoryInput,
  type MemorySearchResult,
  type UpdateMemoryInput,
} from './repository';
import {
  SqliteVecMemoryVectorIndex,
  UnavailableMemoryVectorIndex,
  type EmbeddingProvider,
  type MemoryVectorIndex,
  type SqliteVecMemoryVectorIndexOptions,
} from './vector';
import type { Database } from '../db/types';

export interface MemoryServiceOptions {
  embeddingProvider?: EmbeddingProvider;
  vectorIndex?: MemoryVectorIndex;
  sqliteVec?: Omit<SqliteVecMemoryVectorIndexOptions, 'dimensions'> & { dimensions?: number };
  /** Conservative upper bound for unkeyed semantic duplicate detection. */
  dedupeMaxDistance?: number;
}

export interface MemoryRecallOptions {
  /** Maximum number of memories to expose to the agent. */
  limit?: number;
  /** Number of candidates to inspect before ranking. */
  candidateLimit?: number;
  /** Maximum vector distance accepted as a semantic match. */
  maxDistance?: number;
}

export interface RememberMemoryResult {
  memory: Memory;
  action: 'remembered' | 'updated' | 'already-present';
}

const DEFAULT_MEMORY_RECALL_LIMIT = 6;
const DEFAULT_MEMORY_RECALL_CANDIDATE_LIMIT = 24;
const DEFAULT_MEMORY_RECALL_MAX_DISTANCE = 0.95;
const DEFAULT_MEMORY_DEDUPE_MAX_DISTANCE = 0.36;
const RRF_K = 60;
const RECALL_STOP_WORDS = new Set([
  'a', 'again', 'an', 'and', 'are', 'as', 'at', 'can', 'continue', 'could', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'no', 'now', 'of', 'ok', 'okay',
  'on', 'or', 'our', 'please', 'retry', 'same', 'something', 'that', 'the', 'then', 'this',
  'thing', 'to', 'use', 'what', 'when', 'where', 'which', 'with', 'would', 'yes', 'you', 'your',
]);

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function recallDistance(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('maxDistance must be a non-negative number');
  return value;
}

function recallTokens(query: string): string[] {
  return [...new Set(
    query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu)
      ?.map(token => token.toLocaleLowerCase())
      .filter(token => token.length >= 3 && !RECALL_STOP_WORDS.has(token))
      .slice(0, 32) ?? [],
  )];
}

function lexicalSimilarity(left: string, right: string): number {
  const tokens = (value: string) => new Set(
    value.normalize('NFKC').toLocaleLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [],
  );
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

function recencyBonus(memory: Memory, now: number): number {
  const updated = Date.parse(memory.updatedAt);
  const updatedFactor = Number.isFinite(updated) ? Math.exp(-Math.max(0, now - updated) / (365 * 24 * 60 * 60 * 1_000)) : 0;
  const verification = memory.durability === 'refreshable' && memory.lastVerifiedAt
    ? Date.parse(memory.lastVerifiedAt)
    : Number.NaN;
  const verificationFactor = Number.isFinite(verification)
    ? Math.exp(-Math.max(0, now - verification) / (90 * 24 * 60 * 60 * 1_000))
    : 0;
  return 0.00015 * updatedFactor + 0.0002 * verificationFactor;
}

function secondaryScore(memory: Memory, now: number): number {
  const sourceBonus = memory.source === 'user' || memory.source === 'manual' ? 0.0001 : 0;
  return (0.001 * memory.importance) + sourceBonus + recencyBonus(memory, now);
}

type RankedCandidate = {
  memory: Memory;
  score: number;
};

/** Global memory API. Thread IDs are intentionally absent from this surface. */
export class MemoryService {
  readonly repository: MemoryRepository;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly vectorIndex: MemoryVectorIndex;
  private readonly dedupeMaxDistance: number;

  constructor(database: Database, options: MemoryServiceOptions = {}) {
    this.repository = new MemoryRepository(database);
    this.embeddingProvider = options.embeddingProvider;
    this.dedupeMaxDistance = options.dedupeMaxDistance ?? DEFAULT_MEMORY_DEDUPE_MAX_DISTANCE;
    if (!Number.isFinite(this.dedupeMaxDistance) || this.dedupeMaxDistance < 0) {
      throw new RangeError('dedupeMaxDistance must be a non-negative number');
    }
    if (options.vectorIndex) {
      this.vectorIndex = options.vectorIndex;
    } else if (options.embeddingProvider) {
      const vectorOptions = options.sqliteVec ?? {};
      this.vectorIndex = new SqliteVecMemoryVectorIndex(database, {
        ...vectorOptions,
        dimensions: vectorOptions.dimensions ?? options.embeddingProvider.dimensions,
      });
    } else {
      this.vectorIndex = new UnavailableMemoryVectorIndex('No embedding provider configured');
    }
  }

  async save(input: CreateMemoryInput): Promise<Memory> {
    return (await this.remember(input)).memory;
  }

  async saveIfNew(input: CreateMemoryInput): Promise<Memory> {
    return (await this.remember(input)).memory;
  }

  async remember(input: CreateMemoryInput): Promise<RememberMemoryResult> {
    const normalizedInput: CreateMemoryInput = {
      ...input,
      content: input.content.trim(),
      ...(input.key === undefined ? {} : { key: input.key.trim() || undefined }),
      source: input.source ?? 'user',
      durability: input.durability ?? (input.source === 'observed' ? 'refreshable' : 'durable'),
      ...(input.source === 'observed' ? { lastVerifiedAt: input.lastVerifiedAt ?? new Date().toISOString() } : {}),
      ...(input.evidenceIds ? { evidenceIds: [...new Set(input.evidenceIds)] } : {}),
    };
    if (normalizedInput.source === 'observed' && (normalizedInput.evidenceIds?.length ?? 0) === 0) {
      throw new Error('Observed memories require evidence IDs from successful tool results');
    }
    if (normalizedInput.key?.trim()) {
      const result = this.repository.upsertByKey(normalizedInput);
      await this.reindex(result.memory);
      return { memory: result.memory, action: result.created ? 'remembered' : 'updated' };
    }

    const duplicate = await this.findDuplicate(normalizedInput);
    if (duplicate) {
      if (normalizedInput.source === 'passive-extraction') {
        return { memory: duplicate, action: 'already-present' };
      }
      const updated = this.repository.update(duplicate.id, {
        content: normalizedInput.content,
        kind: normalizedInput.kind,
        importance: normalizedInput.importance,
        metadata: normalizedInput.metadata ?? duplicate.metadata,
        source: normalizedInput.source,
        sourceUrl: normalizedInput.sourceUrl ?? null,
        evidenceIds: normalizedInput.evidenceIds ?? [],
        durability: normalizedInput.durability,
        lastVerifiedAt: normalizedInput.lastVerifiedAt ?? null,
      });
      if (!updated) throw new Error(`Memory disappeared during deduplication: ${duplicate.id}`);
      await this.reindex(updated);
      return { memory: updated, action: 'updated' };
    }

    const memory = await this.saveInternal(normalizedInput);
    return { memory, action: 'remembered' };
  }

  async saveInternal(input: CreateMemoryInput): Promise<Memory> {
    const memory = this.repository.save(input);
    await this.indexMemory(memory);
    return memory;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory | undefined> {
    const memory = this.repository.update(id, input);
    if (memory) await this.reindex(memory);
    return memory;
  }

  async updateByKey(key: string, input: UpdateMemoryInput): Promise<Memory | undefined> {
    const current = this.repository.getByKey(key);
    return current ? this.update(current.id, input) : undefined;
  }

  async forget(input: { id?: string; key?: string }): Promise<boolean> {
    const memory = input.id ? this.repository.getById(input.id) : input.key ? this.repository.getByKey(input.key) : undefined;
    if (!memory) return false;
    const deleted = this.repository.delete(memory.id);
    if (deleted) {
      try {
        await this.vectorIndex.remove(memory.id);
      } catch {
        // The primary memory row and FTS entry are already gone.
      }
    }
    return deleted;
  }

  async delete(id: string): Promise<boolean> {
    return this.forget({ id });
  }

  list(limit?: number): Memory[] {
    return this.repository.list(limit);
  }

  get(id: string): Memory | undefined {
    return this.repository.getById(id);
  }

  getByKey(key: string): Memory | undefined {
    return this.repository.getByKey(key);
  }

  async search(query: string, limit = 20): Promise<Memory[]> {
    const memories = await this.hybridSearch(query, {
      limit,
      candidateLimit: Math.max(24, Math.min(100, limit * 4)),
      maxDistance: DEFAULT_MEMORY_RECALL_MAX_DISTANCE,
    });
    this.repository.touchAccess(memories.map(memory => memory.id));
    return memories;
  }

  /** Retrieve a compact, relevance-first context for an agent run. */
  async recall(query: string, options: MemoryRecallOptions = {}): Promise<Memory[]> {
    const memories = await this.hybridSearch(query, {
      limit: options.limit ?? DEFAULT_MEMORY_RECALL_LIMIT,
      candidateLimit: options.candidateLimit ?? DEFAULT_MEMORY_RECALL_CANDIDATE_LIMIT,
      maxDistance: options.maxDistance ?? DEFAULT_MEMORY_RECALL_MAX_DISTANCE,
    });
    this.repository.touchAccess(memories.map(memory => memory.id));
    return memories;
  }

  searchKeyword(query: string, limit = 20): Memory[] {
    return this.repository.search(query, limit);
  }

  searchDetailed(query: string, limit = 20): MemorySearchResult[] {
    return this.repository.searchDetailed(query, limit);
  }

  async saveText(
    content: string,
    kind: Memory['kind'] = 'note',
    metadata: JsonObject = {},
    importance = 0.5,
  ): Promise<Memory> {
    return this.save({ content, kind, metadata, importance, source: 'manual' });
  }

  private async hybridSearch(query: string, options: Required<MemoryRecallOptions>): Promise<Memory[]> {
    const normalizedQuery = query.normalize('NFKC').trim();
    if (normalizedQuery.length === 0 || recallTokens(normalizedQuery).length === 0) return [];
    const limit = positiveLimit(options.limit, 'limit');
    const candidateLimit = Math.max(limit, positiveLimit(options.candidateLimit, 'candidateLimit'));
    const maxDistance = recallDistance(options.maxDistance);
    const candidates = new Map<string, RankedCandidate>();
    const add = (memory: Memory, rank: number) => {
      const candidate = candidates.get(memory.id) ?? { memory, score: 0 };
      candidate.score += 1 / (RRF_K + rank);
      candidates.set(memory.id, candidate);
    };

    try {
      const ftsResults = this.repository.searchDetailed(normalizedQuery, candidateLimit);
      ftsResults.forEach(({ memory }, index) => add(memory, index + 1));
    } catch {
      // Vector candidates remain usable if FTS is missing or damaged.
    }

    if (this.embeddingProvider && this.vectorIndex.available) {
      try {
        const embedding = await this.embeddingProvider.embed(normalizedQuery);
        const matches = await this.vectorIndex.search(embedding, candidateLimit);
        const byId = new Map(
          this.repository.getManyByIds(matches.map(match => match.memoryId)).map(memory => [memory.id, memory]),
        );
        let vectorRank = 0;
        for (const match of matches) {
          if (!Number.isFinite(match.distance) || match.distance > maxDistance) continue;
          const memory = byId.get(match.memoryId);
          if (!memory) continue;
          add(memory, ++vectorRank);
        }
      } catch {
        // FTS retrieval is still useful if embeddings or sqlite-vec fail.
      }
    }

    const now = Date.now();
    return [...candidates.values()]
      .map(candidate => ({
        memory: candidate.memory,
        score: candidate.score + secondaryScore(candidate.memory, now),
      }))
      .sort((left, right) => right.score - left.score
        || right.memory.importance - left.memory.importance
        || right.memory.updatedAt.localeCompare(left.memory.updatedAt)
        || left.memory.id.localeCompare(right.memory.id))
      .slice(0, limit)
      .map(candidate => candidate.memory);
  }

  private async findDuplicate(input: CreateMemoryInput): Promise<Memory | undefined> {
    const content = normalizedText(input.content);
    const exact = this.repository.findByContent(input.content);
    if (exact && exact.kind === input.kind) return exact;

    const recent = this.repository.list(1_000).filter(memory => memory.kind === input.kind && !memory.key);
    const lexical = recent
      .map(memory => ({ memory, similarity: lexicalSimilarity(content, normalizedText(memory.content)) }))
      .filter(candidate => candidate.similarity >= 0.9)
      .sort((left, right) => right.similarity - left.similarity)[0];
    if (lexical) return lexical.memory;

    if (!this.embeddingProvider || !this.vectorIndex.available) return undefined;
    try {
      const embedding = await this.embeddingProvider.embed(input.content);
      const matches = await this.vectorIndex.search(embedding, 12);
      const duplicateMatch = matches.find(match => Number.isFinite(match.distance) && match.distance <= this.dedupeMaxDistance);
      if (!duplicateMatch) return undefined;
      const candidate = this.repository.getById(duplicateMatch.memoryId);
      return candidate?.kind === input.kind && !candidate.key ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  private async reindex(memory: Memory): Promise<void> {
    try {
      await this.vectorIndex.remove(memory.id);
    } catch {
      // Continue to refresh the index; the durable SQLite and FTS update won.
    }
    await this.indexMemory(memory);
  }

  private async indexMemory(memory: Memory): Promise<void> {
    if (!this.embeddingProvider || !this.vectorIndex.available) return;
    try {
      const embedding = await this.embeddingProvider.embed(`${memory.key ?? ''} ${memory.content}`.trim());
      await this.vectorIndex.upsert(memory.id, embedding);
    } catch {
      // Indexing is an enhancement. SQLite and FTS remain authoritative.
    }
  }
}

export const PersistentMemoryService = MemoryService;
