import type { JsonObject, Memory } from '@helm/shared';

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
}

export interface MemoryRecallOptions {
  /** Maximum number of memories to expose to the agent. */
  limit?: number;
  /** Number of candidates to inspect before applying relevance filtering. */
  candidateLimit?: number;
  /** Maximum vector distance accepted as a semantic match. */
  maxDistance?: number;
}

const DEFAULT_MEMORY_RECALL_LIMIT = 6;
const DEFAULT_MEMORY_RECALL_CANDIDATE_LIMIT = 24;
const DEFAULT_MEMORY_RECALL_MAX_DISTANCE = 0.95;
const RECALL_STOP_WORDS = new Set([
  'a', 'again', 'an', 'and', 'are', 'as', 'at', 'can', 'continue', 'could', 'do', 'does',
  'for', 'from', 'how', 'i', 'in', 'is', 'it', 'me', 'my', 'no', 'now', 'of', 'ok', 'okay',
  'on', 'or', 'our', 'please', 'retry', 'same', 'something', 'that', 'the', 'then', 'this',
  'thing', 'to', 'use', 'what', 'when', 'where', 'which', 'with', 'would', 'yes', 'you', 'your',
]);

function recallLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function recallDistance(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('maxDistance must be a non-negative number');
  return value;
}

/** Global memory API. Thread IDs are intentionally absent from this surface. */
export class MemoryService {
  readonly repository: MemoryRepository;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly vectorIndex: MemoryVectorIndex;

  constructor(database: Database, options: MemoryServiceOptions = {}) {
    this.repository = new MemoryRepository(database);
    this.embeddingProvider = options.embeddingProvider;
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

  save(input: CreateMemoryInput): Promise<Memory> {
    return this.saveInternal(input);
  }

  async saveInternal(input: CreateMemoryInput): Promise<Memory> {
    const memory = this.repository.save(input);
    await this.indexMemory(memory);
    return memory;
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Memory | undefined> {
    const memory = this.repository.update(id, input);
    if (memory) {
      try {
        await this.vectorIndex.remove(id);
      } catch {
        // A stale vector is less useful than a keyword-only fallback, so do
        // not let vector cleanup prevent the durable update from succeeding.
      }
      await this.indexMemory(memory);
    }
    return memory;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.repository.delete(id);
    if (deleted) {
      try {
        await this.vectorIndex.remove(id);
      } catch {
        // The primary memory row is already gone; vector cleanup is optional.
      }
    }
    return deleted;
  }

  list(limit?: number): Memory[] {
    return this.repository.list(limit);
  }

  get(id: string): Memory | undefined {
    return this.repository.getById(id);
  }

  async search(query: string, limit = 20): Promise<Memory[]> {
    if (this.embeddingProvider && this.vectorIndex.available) {
      try {
        const embedding = await this.embeddingProvider.embed(query);
        const matches = await this.vectorIndex.search(embedding, limit);
        const byId = new Map(this.repository.getManyByIds(matches.map(match => match.memoryId)).map(memory => [memory.id, memory]));
        const vectorResults = matches
          .map(match => byId.get(match.memoryId))
          .filter((memory): memory is Memory => memory !== undefined);
        if (vectorResults.length > 0) return vectorResults;
      } catch {
        // A provider or native vector extension may fail after startup. FTS is
        // still a useful, deterministic retrieval path.
      }
    }
    return this.repository.search(query, limit);
  }

  /**
   * Retrieve a small, relevant memory context for an agent run.
   *
   * Keyword matches are retained as an exact-match fallback. Semantic
   * candidates are only included when their vector distance is within the
   * recall threshold, so an unrelated memory cannot be injected merely
   * because it is the nearest item in a small index.
   */
  async recall(query: string, options: MemoryRecallOptions = {}): Promise<Memory[]> {
    const normalizedQuery = query.normalize('NFKC').trim();
    if (normalizedQuery.length === 0) return [];
    if (recallTokens(normalizedQuery).length === 0) return [];

    const limit = recallLimit(options.limit ?? DEFAULT_MEMORY_RECALL_LIMIT, 'limit');
    const candidateLimit = Math.max(
      limit,
      recallLimit(
        options.candidateLimit ?? DEFAULT_MEMORY_RECALL_CANDIDATE_LIMIT,
        'candidateLimit',
      ),
    );
    const maxDistance = recallDistance(options.maxDistance ?? DEFAULT_MEMORY_RECALL_MAX_DISTANCE);
    let keywordResults: Memory[] = [];
    try {
      keywordResults = this.keywordRecall(normalizedQuery, candidateLimit);
    } catch {
      // Semantic retrieval below may still work if the FTS capability is
      // damaged independently of the primary memory table.
    }
    const semanticResults: Memory[] = [];

    if (this.embeddingProvider && this.vectorIndex.available) {
      try {
        const embedding = await this.embeddingProvider.embed(normalizedQuery);
        const matches = await this.vectorIndex.search(embedding, candidateLimit);
        const byId = new Map(
          this.repository
            .getManyByIds(matches.map(match => match.memoryId))
            .map(memory => [memory.id, memory]),
        );
        for (const match of matches) {
          if (!Number.isFinite(match.distance) || match.distance > maxDistance) continue;
          const memory = byId.get(match.memoryId);
          if (memory) semanticResults.push(memory);
        }
      } catch {
        // Recalling memories must never make an otherwise valid agent run fail.
        // Exact keyword retrieval below remains available when embeddings or
        // the native vector extension are unavailable.
      }
    }

    const recalled: Memory[] = [];
    const seen = new Set<string>();
    for (const memory of [...keywordResults, ...semanticResults]) {
      if (seen.has(memory.id)) continue;
      seen.add(memory.id);
      recalled.push(memory);
      if (recalled.length >= limit) break;
    }
    return recalled;
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
    return this.save({ content, kind, metadata, importance });
  }

  private async indexMemory(memory: Memory): Promise<void> {
    if (!this.embeddingProvider || !this.vectorIndex.available) return;
    try {
      const embedding = await this.embeddingProvider.embed(memory.content);
      await this.vectorIndex.upsert(memory.id, embedding);
    } catch {
      // Indexing is an enhancement. Save/update semantics remain durable in
      // the primary SQLite and FTS tables even when native vectors fail.
    }
  }

  private keywordRecall(query: string, limit: number): Memory[] {
    const exactResults = this.repository.search(query, limit);
    if (exactResults.length > 0) return exactResults;

    const tokens = recallTokens(query);
    if (tokens.length === 0) return [];

    const candidates = new Map<string, { memory: Memory; matches: number; firstToken: number }>();
    tokens.forEach((token, tokenIndex) => {
      for (const memory of this.repository.search(token, limit)) {
        const candidate = candidates.get(memory.id);
        if (candidate) {
          candidate.matches += 1;
        } else {
          candidates.set(memory.id, { memory, matches: 1, firstToken: tokenIndex });
        }
      }
    });

    return [...candidates.values()]
      .sort((left, right) => right.matches - left.matches || left.firstToken - right.firstToken)
      .slice(0, limit)
      .map(candidate => candidate.memory);
  }
}

function recallTokens(query: string): string[] {
  return [...new Set(
    query.match(/[\p{L}\p{N}_]+/gu)
      ?.map(token => token.toLocaleLowerCase())
      .filter(token => token.length >= 3 && !RECALL_STOP_WORDS.has(token))
      .slice(0, 8) ?? [],
  )];
}

export const PersistentMemoryService = MemoryService;
