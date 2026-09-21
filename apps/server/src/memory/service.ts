import type { Database } from 'bun:sqlite';
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

export interface MemoryServiceOptions {
  embeddingProvider?: EmbeddingProvider;
  vectorIndex?: MemoryVectorIndex;
  sqliteVec?: Omit<SqliteVecMemoryVectorIndexOptions, 'dimensions'> & { dimensions?: number };
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
    if (memory) await this.indexMemory(memory);
    return memory;
  }

  async delete(id: string): Promise<boolean> {
    const deleted = this.repository.delete(id);
    if (deleted) await this.vectorIndex.remove(id);
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
}

export const PersistentMemoryService = MemoryService;
