import { randomUUID } from 'node:crypto';

import type {
  JsonObject,
  Memory,
  MemoryDurability,
  MemorySource,
} from '@helm/shared';

import { jsonObject, parseJson, stableStringify } from '../db/json';
import type { Database } from '../db/types';

export type MemoryKind = Memory['kind'];

const MEMORY_KINDS = new Set<MemoryKind>(['fact', 'preference', 'instruction', 'note']);
const MEMORY_SOURCES = new Set<MemorySource>(['user', 'observed', 'manual', 'passive-extraction']);
const MEMORY_DURABILITIES = new Set<MemoryDurability>(['durable', 'refreshable']);
const MEMORY_COLUMNS = `id, content, kind, importance, metadata_json AS metadataJson,
  memory_key AS memoryKey, source, source_url AS sourceUrl,
  evidence_ids_json AS evidenceIdsJson, durability,
  last_verified_at AS lastVerifiedAt, last_accessed_at AS lastAccessedAt,
  access_count AS accessCount, created_at AS createdAt, updated_at AS updatedAt`;

export interface CreateMemoryInput {
  content: string;
  kind: MemoryKind;
  importance?: number;
  metadata?: JsonObject;
  key?: string;
  source?: MemorySource;
  sourceUrl?: string;
  evidenceIds?: string[];
  durability?: MemoryDurability;
  lastVerifiedAt?: string;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateMemoryInput {
  content?: string;
  kind?: MemoryKind;
  importance?: number;
  metadata?: JsonObject;
  key?: string | null;
  source?: MemorySource;
  sourceUrl?: string | null;
  evidenceIds?: string[];
  durability?: MemoryDurability | null;
  lastVerifiedAt?: string | null;
  updatedAt?: string;
}

export interface MemorySearchResult {
  memory: Memory;
  rank: number;
}

export class MemoryKeyConflictError extends Error {
  constructor(key: string) {
    super(`A memory already uses the key: ${key}`);
    this.name = 'MemoryKeyConflictError';
  }
}

function now(): string {
  return new Date().toISOString();
}

function requiredContent(value: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error('Memory content must not be empty');
  }
  return value.trim();
}

function importance(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError('Memory importance must be between 0 and 1');
  }
  return value;
}

function memoryKey(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const key = value.trim();
  if (key.length === 0 || key.length > 200) {
    throw new Error('Memory key must contain 1 to 200 characters');
  }
  return key;
}

function sourceUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Memory source URL must be a valid HTTP or HTTPS URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('Memory source URL must be a valid HTTP or HTTPS URL without credentials');
  }
  return parsed.toString();
}

function evidenceIds(value: readonly string[] | undefined): string[] {
  if (value === undefined) return [];
  if (value.length > 20 || value.some(id => typeof id !== 'string' || id.trim().length === 0 || id.length > 200)) {
    throw new Error('Memory evidence IDs must contain at most 20 non-empty strings of 200 characters or fewer');
  }
  return [...new Set(value.map(id => id.trim()))];
}

function verificationDate(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (!Number.isFinite(Date.parse(value))) throw new Error('Memory lastVerifiedAt must be a valid date');
  return new Date(value).toISOString();
}

function mapMemory(row: unknown): Memory {
  const value = row as {
    id: string;
    content: string;
    kind: string;
    importance: number;
    metadataJson: string;
    memoryKey: string | null;
    source: string;
    sourceUrl: string | null;
    evidenceIdsJson: string;
    durability: string | null;
    lastVerifiedAt: string | null;
    lastAccessedAt: string | null;
    accessCount: number;
    createdAt: string;
    updatedAt: string;
  };
  if (!MEMORY_KINDS.has(value.kind as MemoryKind)) {
    throw new Error(`Invalid persisted memory kind: ${value.kind}`);
  }
  if (!MEMORY_SOURCES.has(value.source as MemorySource)) {
    throw new Error(`Invalid persisted memory source: ${value.source}`);
  }
  if (value.durability !== null && !MEMORY_DURABILITIES.has(value.durability as MemoryDurability)) {
    throw new Error(`Invalid persisted memory durability: ${value.durability}`);
  }
  const metadata = jsonObject(parseJson<unknown>(value.metadataJson, 'memory.metadata_json'), 'memory.metadata_json');
  const parsedEvidenceIds = parseJson<unknown>(value.evidenceIdsJson, 'memory.evidence_ids_json');
  const ids = Array.isArray(parsedEvidenceIds)
    ? parsedEvidenceIds.filter((id): id is string => typeof id === 'string')
    : [];
  return {
    id: value.id,
    content: value.content,
    kind: value.kind as MemoryKind,
    importance: value.importance,
    metadata,
    ...(value.memoryKey ? { key: value.memoryKey } : {}),
    source: value.source as MemorySource,
    ...(value.sourceUrl ? { sourceUrl: value.sourceUrl } : {}),
    evidenceIds: ids,
    ...(value.durability ? { durability: value.durability as MemoryDurability } : {}),
    ...(value.lastVerifiedAt ? { lastVerifiedAt: value.lastVerifiedAt } : {}),
    ...(value.lastAccessedAt ? { lastAccessedAt: value.lastAccessedAt } : {}),
    accessCount: value.accessCount,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function ftsQuery(query: string): string | undefined {
  const tokens = [...new Set(query.normalize('NFKC').match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 32);
  if (tokens.length === 0) return undefined;
  return tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' OR ');
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
    const content = requiredContent(input.content);
    if (!MEMORY_KINDS.has(input.kind)) throw new Error(`Invalid memory kind: ${input.kind}`);
    const score = importance(input.importance ?? 0.5);
    const metadata = input.metadata ?? {};
    jsonObject(metadata, 'memory.metadata');
    const key = memoryKey(input.key);
    const source = input.source ?? 'manual';
    if (!MEMORY_SOURCES.has(source)) throw new Error(`Invalid memory source: ${source}`);
    const url = sourceUrl(input.sourceUrl);
    const ids = evidenceIds(input.evidenceIds);
    const durability = input.durability ?? (source === 'observed' ? 'refreshable' : 'durable');
    if (!MEMORY_DURABILITIES.has(durability)) throw new Error(`Invalid memory durability: ${durability}`);
    const verifiedAt = verificationDate(input.lastVerifiedAt);

    const insert = this.database.transaction(() => {
      this.database
        .prepare(`INSERT INTO memories (
          id, content, kind, importance, metadata_json, memory_key, source, source_url,
          evidence_ids_json, durability, last_verified_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          id, content, input.kind, score, stableStringify(metadata), key ?? null, source, url ?? null,
          stableStringify(ids), durability, verifiedAt ?? null, createdAt, updatedAt,
        );
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
      key: input.key,
      source: input.source,
      sourceUrl: input.sourceUrl,
      evidenceIds: input.evidenceIds,
      durability: input.durability,
      lastVerifiedAt: input.lastVerifiedAt,
      updatedAt: input.updatedAt,
    });
    return updated as Memory;
  }

  upsertByKey(input: CreateMemoryInput): { memory: Memory; created: boolean } {
    const key = memoryKey(input.key);
    if (!key) return { memory: this.create(input), created: true };
    const upsert = this.database.transaction(() => {
      const existing = this.getByKey(key);
      if (!existing) return { memory: this.create({ ...input, key }), created: true };
      const memory = this.update(existing.id, {
        content: input.content,
        kind: input.kind,
        importance: input.importance,
        metadata: input.metadata ?? existing.metadata,
        source: input.source ?? existing.source,
        sourceUrl: input.sourceUrl ?? null,
        evidenceIds: input.evidenceIds ?? [],
        durability: input.durability ?? existing.durability ?? (input.source === 'observed' ? 'refreshable' : 'durable'),
        lastVerifiedAt: input.lastVerifiedAt ?? null,
      });
      if (!memory) throw new Error(`Memory disappeared during keyed upsert: ${key}`);
      return { memory, created: false };
    });
    return upsert.immediate();
  }

  getById(id: string): Memory | undefined {
    const row = this.database.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE id = ?`).get(id);
    return row === undefined ? undefined : mapMemory(row);
  }

  get(id: string): Memory | undefined {
    return this.getById(id);
  }

  findById(id: string): Memory | undefined {
    return this.getById(id);
  }

  getByKey(key: string): Memory | undefined {
    const row = this.database.prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE memory_key = ?`).get(key);
    return row === undefined ? undefined : mapMemory(row);
  }

  findByKey(key: string): Memory | undefined {
    return this.getByKey(key);
  }

  findByContent(content: string): Memory | undefined {
    const row = this.database
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories WHERE content = ? ORDER BY updated_at DESC, id DESC LIMIT 1`)
      .get(content.trim());
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
      .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories ORDER BY updated_at DESC, id DESC LIMIT ?`)
      .all(limitValue(limit ?? 100));
    return rows.map(mapMemory);
  }

  update(id: string, input: UpdateMemoryInput): Memory | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const content = input.content === undefined ? current.content : requiredContent(input.content);
    const kind = input.kind ?? current.kind;
    const score = input.importance === undefined ? current.importance : importance(input.importance);
    const metadata = input.metadata ?? current.metadata;
    const key = input.key === undefined ? current.key : memoryKey(input.key);
    const source = input.source ?? current.source ?? 'manual';
    const url = input.sourceUrl === undefined ? current.sourceUrl : sourceUrl(input.sourceUrl);
    const ids = input.evidenceIds === undefined ? current.evidenceIds ?? [] : evidenceIds(input.evidenceIds);
    const durability = input.durability === undefined ? current.durability : input.durability ?? undefined;
    const verifiedAt = input.lastVerifiedAt === undefined ? current.lastVerifiedAt : verificationDate(input.lastVerifiedAt);
    if (!MEMORY_KINDS.has(kind)) throw new Error(`Invalid memory kind: ${kind}`);
    if (!MEMORY_SOURCES.has(source)) throw new Error(`Invalid memory source: ${source}`);
    if (durability !== undefined && !MEMORY_DURABILITIES.has(durability)) throw new Error(`Invalid memory durability: ${durability}`);
    jsonObject(metadata, 'memory.metadata');
    const conflicting = key ? this.getByKey(key) : undefined;
    if (conflicting && conflicting.id !== id) throw new MemoryKeyConflictError(key!);
    const updatedAt = input.updatedAt ?? now();

    const update = this.database.transaction(() => {
      this.database
        .prepare(`UPDATE memories SET
          content = ?, kind = ?, importance = ?, metadata_json = ?, memory_key = ?, source = ?, source_url = ?,
          evidence_ids_json = ?, durability = ?, last_verified_at = ?, updated_at = ?
          WHERE id = ?`)
        .run(
          content, kind, score, stableStringify(metadata), key ?? null, source, url ?? null,
          stableStringify(ids), durability ?? null, verifiedAt ?? null, updatedAt, id,
        );
      this.syncFts(id);
    });
    update.immediate();
    return this.getById(id);
  }

  touchAccess(ids: readonly string[], accessedAt = now()): void {
    if (ids.length === 0) return;
    const touch = this.database.prepare(`UPDATE memories
      SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id = ?`);
    const transaction = this.database.transaction(() => {
      for (const id of new Set(ids)) touch.run(accessedAt, id);
    });
    transaction.immediate();
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
                  memories.metadata_json AS metadataJson, memories.memory_key AS memoryKey,
                  memories.source, memories.source_url AS sourceUrl,
                  memories.evidence_ids_json AS evidenceIdsJson, memories.durability,
                  memories.last_verified_at AS lastVerifiedAt, memories.last_accessed_at AS lastAccessedAt,
                  memories.access_count AS accessCount, memories.created_at AS createdAt,
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
        .prepare(`SELECT ${MEMORY_COLUMNS} FROM memories
          WHERE content LIKE ? COLLATE NOCASE OR COALESCE(memory_key, '') LIKE ? COLLATE NOCASE
          ORDER BY updated_at DESC, id DESC LIMIT ?`)
        .all(pattern, pattern, normalizedLimit);
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
        .prepare('SELECT id, content, kind, memory_key AS memoryKey FROM memories WHERE id = ?')
        .get(id) as { id: string; content: string; kind: string; memoryKey: string | null } | undefined;
      if (row) {
        this.database
          .prepare('INSERT INTO memory_fts (memory_id, content, kind, memory_key) VALUES (?, ?, ?, ?)')
          .run(row.id, row.content, row.kind, row.memoryKey ?? '');
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
