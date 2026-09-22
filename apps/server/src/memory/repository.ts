import { randomUUID } from 'node:crypto';

import type { JsonObject, Memory } from '@helm/shared';

import { jsonObject, parseJson, stableStringify } from '../db/json';
import type { Database } from '../db/types';

export type MemoryKind = Memory['kind'];

const MEMORY_KINDS = new Set<MemoryKind>(['fact', 'preference', 'instruction', 'note']);

export interface CreateMemoryInput {
  content: string;
  kind: MemoryKind;
  importance?: number;
  metadata?: JsonObject;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateMemoryInput {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  metadata?: JsonObject;
  updatedAt?: string;
}

export interface MemorySearchResult {
  memory: Memory;
  rank: number;
}

function now(): string {
  return new Date().toISOString();
}

function requiredContent(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Memory content must not be empty');
  }
  return value;
}

function importance(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Memory importance must be between 0 and 1');
  }
  return value;
}

function mapMemory(row: unknown): Memory {
  const value = row as {
    id: string;
    content: string;
    kind: string;
    importance: number;
    metadataJson: string;
    createdAt: string;
    updatedAt: string;
  };
  if (!MEMORY_KINDS.has(value.kind as MemoryKind)) {
    throw new Error(`Invalid persisted memory kind: ${value.kind}`);
  }
  const metadata = jsonObject(parseJson<unknown>(value.metadataJson, 'memory.metadata_json'), 'memory.metadata_json');
  return {
    id: value.id,
    content: value.content,
    kind: value.kind as MemoryKind,
    importance: value.importance,
    metadata,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function ftsQuery(query: string): string | undefined {
  const tokens = query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (tokens.length === 0) return undefined;
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

function limitValue(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit must be a positive integer');
  return limit;
}

/** Typed persistence for global memories and their FTS5 mirror. */
export class MemoryRepository {
  constructor(
    private readonly database: Database,
    private readonly idFactory: () => string = () => randomUUID(),
  ) {}

  create(input: CreateMemoryInput): Memory {
    const id = input.id ?? this.idFactory();
    const createdAt = input.createdAt ?? now();
    const updatedAt = input.updatedAt ?? createdAt;
    requiredContent(input.content);
    if (!MEMORY_KINDS.has(input.kind)) throw new Error(`Invalid memory kind: ${input.kind}`);
    const value = importance(input.importance ?? 0.5);
    const metadata = input.metadata ?? {};
    jsonObject(metadata, 'memory.metadata');

    const insert = this.database.transaction(() => {
      this.database
        .prepare(
          'INSERT INTO memories (id, content, kind, importance, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.content, input.kind, value, stableStringify(metadata), createdAt, updatedAt);
      this.syncFts(id);
    });
    insert.immediate();
    return this.getById(id) as Memory;
  }

  save(input: CreateMemoryInput): Memory {
    return this.create(input);
  }

  upsert(input: CreateMemoryInput): Memory {
    if (!input.id || !this.getById(input.id)) return this.create(input);
    const updated = this.update(input.id, {
      content: input.content,
      kind: input.kind,
      importance: input.importance,
      metadata: input.metadata,
      updatedAt: input.updatedAt,
    });
    return updated as Memory;
  }

  getById(id: string): Memory | undefined {
    const row = this.database
      .prepare(
        'SELECT id, content, kind, importance, metadata_json AS metadataJson, created_at AS createdAt, updated_at AS updatedAt FROM memories WHERE id = ?',
      )
      .get(id);
    return row === undefined ? undefined : mapMemory(row);
  }

  get(id: string): Memory | undefined {
    return this.getById(id);
  }

  findById(id: string): Memory | undefined {
    return this.getById(id);
  }

  findByContent(content: string): Memory | undefined {
    const row = this.database
      .prepare(
        'SELECT id, content, kind, importance, metadata_json AS metadataJson, created_at AS createdAt, updated_at AS updatedAt FROM memories WHERE content = ? ORDER BY updated_at DESC, id DESC LIMIT 1',
      )
      .get(content);
    return row === undefined ? undefined : mapMemory(row);
  }

  getManyByIds(ids: readonly string[]): Memory[] {
    if (ids.length === 0) return [];
    const result: Memory[] = [];
    for (const id of ids) {
      const memory = this.getById(id);
      if (memory) result.push(memory);
    }
    return result;
  }

  list(limit?: number): Memory[] {
    const rows = this.database
      .prepare(
        'SELECT id, content, kind, importance, metadata_json AS metadataJson, created_at AS createdAt, updated_at AS updatedAt FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?',
      )
      .all(limitValue(limit ?? 100));
    return rows.map(mapMemory);
  }

  update(id: string, input: UpdateMemoryInput): Memory | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const content = input.content ?? current.content;
    const kind = input.kind ?? current.kind;
    const value = input.importance ?? current.importance;
    const metadata = input.metadata ?? current.metadata;
    requiredContent(content);
    if (!MEMORY_KINDS.has(kind)) throw new Error(`Invalid memory kind: ${kind}`);
    importance(value);
    jsonObject(metadata, 'memory.metadata');
    const updatedAt = input.updatedAt ?? now();

    const update = this.database.transaction(() => {
      this.database
        .prepare(
          'UPDATE memories SET content = ?, kind = ?, importance = ?, metadata_json = ?, updated_at = ? WHERE id = ?',
        )
        .run(content, kind, value, stableStringify(metadata), updatedAt, id);
      this.syncFts(id);
    });
    update.immediate();
    return this.getById(id);
  }

  delete(id: string): boolean {
    const remove = this.database.transaction(() => {
      this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id);
      return this.database.prepare('DELETE FROM memories WHERE id = ?').run(id).changes > 0;
    });
    return remove.immediate();
  }

  remove(id: string): boolean {
    return this.delete(id);
  }

  search(query: string, limit = 20): Memory[] {
    return this.searchDetailed(query, limit).map(result => result.memory);
  }

  searchDetailed(query: string, limit = 20): MemorySearchResult[] {
    const normalizedLimit = limitValue(limit);
    const match = ftsQuery(query);
    if (!match) return [];

    try {
      const rows = this.database
        .prepare(
          `SELECT memories.id, memories.content, memories.kind, memories.importance,
                  memories.metadata_json AS metadataJson, memories.created_at AS createdAt,
                  memories.updated_at AS updatedAt, bm25(memory_fts) AS rank
             FROM memory_fts
             JOIN memories ON memories.id = memory_fts.memory_id
            WHERE memory_fts MATCH ?
            ORDER BY rank ASC, memories.updated_at DESC, memories.id DESC
            LIMIT ?`,
        )
        .all(match, normalizedLimit) as Array<Record<string, unknown>>;
      return rows.map(row => ({ memory: mapMemory(row), rank: Number(row.rank) }));
    } catch (error) {
      if (!/no such table|no such module|fts5/iu.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      const pattern = `%${query}%`;
      const rows = this.database
        .prepare(
          `SELECT id, content, kind, importance, metadata_json AS metadataJson,
                  created_at AS createdAt, updated_at AS updatedAt
             FROM memories
            WHERE content LIKE ? COLLATE NOCASE
            ORDER BY updated_at DESC, id DESC
            LIMIT ?`,
        )
        .all(pattern, normalizedLimit);
      return rows.map(row => ({ memory: mapMemory(row), rank: 0 }));
    }
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM memories').get() as { count: number };
    return row.count;
  }

  private syncFts(id: string): void {
    try {
      this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(id);
      const row = this.database
        .prepare('SELECT id, content, kind FROM memories WHERE id = ?')
        .get(id) as { id: string; content: string; kind: string } | undefined;
      if (row) {
        this.database
          .prepare('INSERT INTO memory_fts (memory_id, content, kind) VALUES (?, ?, ?)')
          .run(row.id, row.content, row.kind);
      }
    } catch (error) {
      if (!/no such table|no such module|fts5/iu.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
      // SQLite can be built without FTS5. The primary memory table remains
      // usable and searchDetailed has a LIKE fallback for that environment.
    }
  }
}
