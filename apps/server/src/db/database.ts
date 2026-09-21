import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { Database } from 'bun:sqlite';
import * as sqliteVec from 'sqlite-vec';
import {
  getDatabaseDiagnostics,
  type DatabaseDiagnostics,
} from './diagnostics';
import { runMigrations, type MigrationResult } from './migrations';
import {
  MessageRepository,
  RunRepository,
  RunStepRepository,
  ThreadRepository,
} from './repositories';

export interface DatabaseOpenOptions {
  readonly?: boolean;
  migrate?: boolean;
  foreignKeys?: boolean;
}

/** A single persistence boundary shared by all typed repositories. */
export class PersistenceDatabase {
  readonly sqlite: Database;
  readonly db: Database;
  readonly migrations: MigrationResult;
  readonly threads: ThreadRepository;
  readonly messages: MessageRepository;
  readonly runs: RunRepository;
  readonly runSteps: RunStepRepository;

  constructor(filename = ':memory:', options: DatabaseOpenOptions = {}) {
    if (filename !== ':memory:' && filename !== '') {
      mkdirSync(dirname(filename), { recursive: true });
    }

    this.sqlite = new Database(filename, {
      readonly: options.readonly ?? false,
      readwrite: !(options.readonly ?? false),
      create: !(options.readonly ?? false),
      strict: true,
    });
    try {
      sqliteVec.load(this.sqlite);
    } catch {
      // sqlite-vec is optional. The memory vector adapter records the
      // capability failure and keeps FTS5 available as the fallback.
    }
    this.db = this.sqlite;

    if (options.foreignKeys ?? true) {
      this.sqlite.exec('PRAGMA foreign_keys = ON');
    }
    this.sqlite.exec('PRAGMA busy_timeout = 5000');
    this.migrations =
      options.migrate === false
        ? { applied: [], currentVersion: 0 }
        : runMigrations(this.sqlite);

    this.threads = new ThreadRepository(this.sqlite);
    this.messages = new MessageRepository(this.sqlite);
    this.runs = new RunRepository(this.sqlite);
    this.runSteps = new RunStepRepository(this.sqlite);
  }

  diagnostics(): DatabaseDiagnostics {
    return getDatabaseDiagnostics(this.sqlite);
  }

  close(): void {
    this.sqlite.close(true);
  }
}

export class HelmDatabase extends PersistenceDatabase {}
export class DatabaseService extends PersistenceDatabase {}

export function createDatabase(
  filename = ':memory:',
  options: DatabaseOpenOptions = {},
): PersistenceDatabase {
  return new PersistenceDatabase(filename, options);
}

export const createPersistenceDatabase = createDatabase;

/** Open a migrated raw Bun database for callers that own their repositories. */
export function openDatabase(
  filename = ':memory:',
  options: DatabaseOpenOptions = {},
): Database {
  const persistence = new PersistenceDatabase(filename, options);
  return persistence.sqlite;
}
