import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

import type { Database } from '../db/types';

export interface MemoryVectorMatch {
  memoryId: string;
  distance: number;
}

export interface MemoryVectorIndex {
  readonly available: boolean;

  upsert(memoryId: string, embedding: Float32Array): Promise<void>;

  search(embedding: Float32Array, limit: number): Promise<MemoryVectorMatch[]>;

  remove(memoryId: string): Promise<void>;
}

export interface EmbeddingProvider {
  readonly dimensions: number;

  embed(text: string): Promise<Float32Array>;
}

export class UnavailableMemoryVectorIndex implements MemoryVectorIndex {
  readonly available = false;

  constructor(readonly reason = 'sqlite-vec is unavailable') {}

  async upsert(_memoryId: string, _embedding: Float32Array): Promise<void> {
    // Vector persistence is optional. FTS remains the authoritative fallback.
  }

  async search(_embedding: Float32Array, _limit: number): Promise<MemoryVectorMatch[]> {
    return [];
  }

  async remove(_memoryId: string): Promise<void> {
    // Keep unavailable indexes harmless for callers that always clean up IDs.
  }
}

export class DeterministicFakeEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions = 8) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new RangeError('Embedding dimensions must be a positive integer');
    }
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const normalized = text.normalize('NFKC').trim().toLowerCase();
    const vector = new Float32Array(this.dimensions);
    if (normalized.length === 0) {
      vector[0] = 1;
      return vector;
    }

    const bytes = new TextEncoder().encode(normalized);
    let hash = 2_166_136_261;
    for (let index = 0; index < bytes.length; index += 1) {
      hash ^= bytes[index];
      hash = Math.imul(hash, 16_777_619) >>> 0;
      const bucket = index % this.dimensions;
      vector[bucket] += ((hash / 4_294_967_295) * 2 - 1) / Math.sqrt(bytes.length);
    }

    const tokens = normalized.split(/\s+/u).filter(Boolean);
    for (const token of tokens) {
      let tokenHash = 2_166_136_261;
      for (const byte of new TextEncoder().encode(token)) {
        tokenHash ^= byte;
        tokenHash = Math.imul(tokenHash, 16_777_619) >>> 0;
      }
      vector[tokenHash % this.dimensions] += 0.25;
    }

    let length = 0;
    for (const value of vector) length += value * value;
    const norm = Math.sqrt(length) || 1;
    for (let index = 0; index < vector.length; index += 1) vector[index] /= norm;
    return vector;
  }
}

export class FakeEmbeddingProvider extends DeterministicFakeEmbeddingProvider {}

function validateEmbedding(embedding: Float32Array, dimensions: number): void {
  if (embedding.length !== dimensions) {
    throw new RangeError(`Expected an embedding with ${dimensions} dimensions, received ${embedding.length}`);
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) throw new TypeError('Embeddings must contain finite numbers');
  }
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Vector search limit must be a positive integer');
  return limit;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(identifier)) {
    throw new Error(`Invalid SQLite identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export interface SqliteVecMemoryVectorIndexOptions {
  dimensions: number;
  extensionPath?: string;
  tableName?: string;
  keyTableName?: string;
  extensionLoader?: (database: Database) => void;
}

export interface SqliteVecLoadStatus {
  available: boolean;
  version?: string;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function packageExtensionPath(): string | undefined {
  const require = createRequire(import.meta.url);
  try {
    const entry = require.resolve('sqlite-vec') as string;
    const root = dirname(entry);
    const candidates = [
      join(root, 'vec0'),
      join(root, 'vec0.dylib'),
      join(root, 'vec0.so'),
      join(root, 'vec0.dll'),
      join(root, 'dist', 'vec0'),
      join(root, 'dist', 'vec0.dylib'),
      join(root, 'dist', 'vec0.so'),
      join(root, 'dist', 'vec0.dll'),
    ];
    for (const candidate of candidates) {
      try {
        if (Bun.file(candidate).size > 0) return candidate;
      } catch {
        // File probing is best effort; the package loader below may still work.
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function loadSqliteVec(database: Database, extensionPath?: string, extensionLoader?: (database: Database) => void): void {
  if (extensionLoader) {
    extensionLoader(database);
    return;
  }

  const configuredPath = extensionPath ?? process.env.HELM_SQLITE_VEC_EXTENSION;
  if (configuredPath) {
    database.loadExtension(configuredPath);
    return;
  }

  const require = createRequire(import.meta.url);
  const moduleValue = require('sqlite-vec') as unknown;
  if (typeof moduleValue === 'object' && moduleValue !== null) {
    const candidate = moduleValue as {
      load?: (database: unknown) => void;
      default?: { load?: (database: unknown) => void };
    };
    if (typeof candidate.load === 'function') {
      candidate.load(database);
      return;
    }
    if (typeof candidate.default?.load === 'function') {
      candidate.default.load(database);
      return;
    }
  }

  const packagePath = packageExtensionPath();
  if (packagePath) {
    database.loadExtension(packagePath);
    return;
  }
  throw new Error('sqlite-vec package did not expose a loader or a native extension path');
}

/**
 * sqlite-vec-backed index. Construction never throws for capability errors;
 * inspect `available` and `loadStatus` and use FTS when it is false.
 */
export class SqliteVecMemoryVectorIndex implements MemoryVectorIndex {
  readonly available: boolean;
  readonly loadStatus: SqliteVecLoadStatus;
  readonly dimensions: number;
  private readonly tableName: string;
  private readonly keyTableName: string;
  private readonly database: Database;

  constructor(database: Database, options: SqliteVecMemoryVectorIndexOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new RangeError('sqlite-vec dimensions must be a positive integer');
    }
    this.database = database;
    this.dimensions = options.dimensions;
    this.tableName = options.tableName ?? 'helm_memory_vectors';
    this.keyTableName = options.keyTableName ?? 'helm_memory_vector_keys';
    quoteIdentifier(this.tableName);
    quoteIdentifier(this.keyTableName);

    try {
      loadSqliteVec(database, options.extensionPath, options.extensionLoader);
      const version = database.prepare('SELECT vec_version() AS version').get() as { version: string };
      database.exec(
        `CREATE TABLE IF NOT EXISTS ${quoteIdentifier(this.keyTableName)} (vector_rowid INTEGER PRIMARY KEY, memory_id TEXT NOT NULL UNIQUE)`,
      );
      database.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${quoteIdentifier(this.tableName)} USING vec0(embedding float[${this.dimensions}])`,
      );
      this.available = true;
      this.loadStatus = { available: true, version: version.version };
    } catch (error) {
      this.available = false;
      this.loadStatus = { available: false, error: errorMessage(error) };
    }
  }

  async upsert(memoryId: string, embedding: Float32Array): Promise<void> {
    if (!this.available) return;
    validateEmbedding(embedding, this.dimensions);
    const table = quoteIdentifier(this.tableName);
    const keys = quoteIdentifier(this.keyTableName);
    const write = this.database.transaction(() => {
      this.database.prepare(`INSERT OR IGNORE INTO ${keys} (memory_id) VALUES (?)`).run(memoryId);
      const row = this.database
        .prepare(`SELECT vector_rowid AS vectorRowid FROM ${keys} WHERE memory_id = ?`)
        .get(memoryId) as { vectorRowid: number | bigint } | undefined;
      if (!row) throw new Error(`Unable to allocate vector row for memory ${memoryId}`);
      const vectorRowid = typeof row.vectorRowid === 'bigint' ? row.vectorRowid : BigInt(row.vectorRowid);
      this.database.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(vectorRowid);
      this.database
        .prepare(`INSERT INTO ${table} (rowid, embedding) VALUES (?, vec_f32(?))`)
        .run(vectorRowid, embedding);
    });
    write.immediate();
  }

  async search(embedding: Float32Array, limit: number): Promise<MemoryVectorMatch[]> {
    if (!this.available) return [];
    validateEmbedding(embedding, this.dimensions);
    validateLimit(limit);
    const table = quoteIdentifier(this.tableName);
    const keys = quoteIdentifier(this.keyTableName);
    const rows = this.database
      .prepare(
        `SELECT keys.memory_id AS memoryId, vectors.distance AS distance
          FROM ${table} AS vectors
           JOIN ${keys} AS keys ON keys.vector_rowid = vectors.rowid
          WHERE vectors.embedding MATCH ?
            AND vectors.k = ?
          ORDER BY vectors.distance ASC`,
      )
      .all(embedding, limit) as Array<{ memoryId: string; distance: number }>;
    return rows.map(row => ({ memoryId: row.memoryId, distance: row.distance }));
  }

  async remove(memoryId: string): Promise<void> {
    if (!this.available) return;
    const table = quoteIdentifier(this.tableName);
    const keys = quoteIdentifier(this.keyTableName);
    const remove = this.database.transaction(() => {
      const row = this.database
        .prepare(`SELECT vector_rowid AS vectorRowid FROM ${keys} WHERE memory_id = ?`)
        .get(memoryId) as { vectorRowid: number | bigint } | undefined;
      if (!row) return;
      const vectorRowid = typeof row.vectorRowid === 'bigint' ? row.vectorRowid : BigInt(row.vectorRowid);
      this.database.prepare(`DELETE FROM ${table} WHERE rowid = ?`).run(vectorRowid);
      this.database.prepare(`DELETE FROM ${keys} WHERE memory_id = ?`).run(memoryId);
    });
    remove.immediate();
  }
}

export class InMemoryMemoryVectorIndex implements MemoryVectorIndex {
  readonly available = true;
  private readonly vectors = new Map<string, Float32Array>();

  constructor(readonly dimensions: number) {
    if (!Number.isInteger(dimensions) || dimensions < 1) {
      throw new RangeError('In-memory vector dimensions must be a positive integer');
    }
  }

  async upsert(memoryId: string, embedding: Float32Array): Promise<void> {
    validateEmbedding(embedding, this.dimensions);
    this.vectors.set(memoryId, new Float32Array(embedding));
  }

  async search(embedding: Float32Array, limit: number): Promise<MemoryVectorMatch[]> {
    validateEmbedding(embedding, this.dimensions);
    validateLimit(limit);
    const matches: MemoryVectorMatch[] = [];
    for (const [memoryId, vector] of this.vectors) {
      let distance = 0;
      for (let index = 0; index < vector.length; index += 1) {
        const difference = vector[index] - embedding[index];
        distance += difference * difference;
      }
      matches.push({ memoryId, distance: Math.sqrt(distance) });
    }
    return matches.sort((left, right) => left.distance - right.distance).slice(0, limit);
  }

  async remove(memoryId: string): Promise<void> {
    this.vectors.delete(memoryId);
  }
}

export function createSqliteVecMemoryVectorIndex(
  database: Database,
  options: SqliteVecMemoryVectorIndexOptions,
): SqliteVecMemoryVectorIndex {
  return new SqliteVecMemoryVectorIndex(database, options);
}

export function createUnavailableVectorIndex(reason?: string): UnavailableMemoryVectorIndex {
  return new UnavailableMemoryVectorIndex(reason);
}
