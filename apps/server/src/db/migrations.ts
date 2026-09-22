import { stableStringify } from './json';
import type { Database } from './types';

export interface DatabaseMigration {
  version: number;
  name: string;
  up: (database: Database) => void;
}

export interface MigrationResult {
  applied: Array<{ version: number; name: string }>;
  currentVersion: number;
}

const CORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS threads (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY NOT NULL,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    goal TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'blocked', 'completed', 'failed', 'cancelled')),
    criteria_json TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS run_steps (
    id TEXT PRIMARY KEY NOT NULL,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    step_index INTEGER NOT NULL CHECK (step_index >= 0),
    phase TEXT NOT NULL CHECK (phase IN ('observe', 'reason', 'act', 'verify', 'complete', 'blocked', 'failed')),
    decision_json TEXT,
    tool_name TEXT,
    tool_input_json TEXT,
    tool_result_json TEXT,
    observation_json TEXT,
    verification_json TEXT,
    created_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY NOT NULL,
    content TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference', 'instruction', 'note')),
    importance REAL NOT NULL CHECK (importance >= 0 AND importance <= 1),
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

const INDEX_AND_FTS_SQL = `
  CREATE INDEX IF NOT EXISTS idx_messages_thread_created
    ON messages(thread_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_runs_thread_created
    ON runs(thread_id, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_run_steps_run_index
    ON run_steps(run_id, step_index, created_at, id);
  CREATE INDEX IF NOT EXISTS idx_memories_updated
    ON memories(updated_at DESC, id);

  CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
    memory_id UNINDEXED,
    content,
    kind UNINDEXED,
    tokenize = 'unicode61'
  );
`;

export const migrations: readonly DatabaseMigration[] = [
  {
    version: 1,
    name: 'core-persistence-tables',
    up(database) {
      database.exec(CORE_SCHEMA_SQL);
    },
  },
  {
    version: 2,
    name: 'persistence-indexes-and-memory-fts',
    up(database) {
      database.exec(INDEX_AND_FTS_SQL);
    },
  },
  {
    version: 3,
    name: 'run-task-state-snapshots',
    up(database) {
      database.exec(`
        ALTER TABLE runs ADD COLUMN task_json TEXT;
        ALTER TABLE runs ADD COLUMN state_json TEXT;
      `);
    },
  },
  {
    version: 4,
    name: 'orchestrator-step-observability',
    up(database) {
      database.exec(`
        ALTER TABLE run_steps ADD COLUMN orchestrator_decision_json TEXT;
        ALTER TABLE run_steps ADD COLUMN objective_json TEXT;
        ALTER TABLE run_steps ADD COLUMN worker TEXT;
        ALTER TABLE run_steps ADD COLUMN worker_result_json TEXT;
        ALTER TABLE run_steps ADD COLUMN progress_json TEXT;
      `);
    },
  },
];

export const MIGRATIONS = migrations;

function ensureMigrationTable(database: Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

function currentVersion(database: Database): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number } | undefined;
  return row?.version ?? 0;
}

/** Apply each unapplied migration exactly once and leave a durable audit row. */
export function runMigrations(
  database: Database,
  availableMigrations: readonly DatabaseMigration[] = migrations,
): MigrationResult {
  ensureMigrationTable(database);
  const applied: Array<{ version: number; name: string }> = [];
  const knownVersions = new Set<number>();

  for (const migration of availableMigrations) {
    if (knownVersions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    knownVersions.add(migration.version);
  }

  const ordered = [...availableMigrations].sort((left, right) => left.version - right.version);
  for (const migration of ordered) {
    const existing = database
      .prepare('SELECT version, name FROM schema_migrations WHERE version = ?')
      .get(migration.version) as { version: number; name: string } | undefined;
    if (existing) {
      if (existing.name !== migration.name) {
        throw new Error(
          `Migration ${migration.version} is recorded as ${existing.name}, not ${migration.name}`,
        );
      }
      continue;
    }

    const apply = database.transaction(() => {
      migration.up(database);
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${migration.version}`);
    });
    apply.immediate();
    applied.push({ version: migration.version, name: migration.name });
  }

  const version = currentVersion(database);
  // Keep this serialization in the migration module so migration results are
  // stable when diagnostics or tests log them.
  stableStringify({ applied, currentVersion: version });
  return { applied, currentVersion: version };
}

export function getAppliedMigrations(database: Database): Array<{
  version: number;
  name: string;
  appliedAt: string;
}> {
  ensureMigrationTable(database);
  const rows = database
    .prepare('SELECT version, name, applied_at AS appliedAt FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string; appliedAt: string }>;
  return rows;
}
