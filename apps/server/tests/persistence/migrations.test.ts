import { describe, expect, it } from 'bun:test';

import { getAppliedMigrations, migrations, runMigrations } from '../../src/db/migrations';
import { PersistenceDatabase } from '../../src/db/database';
import { MemoryRepository } from '../../src/memory/repository';
import { testDatabase } from './helpers';

describe('persistence migrations', () => {
  it('creates all persistence tables and is idempotent', () => {
    const persistence = testDatabase();
    try {
      expect(persistence.migrations.currentVersion).toBe(5);
      expect(persistence.migrations.applied.map(migration => migration.version)).toEqual([1, 2, 3, 4, 5]);

      const tables = persistence.sqlite
        .prepare(
          `SELECT name FROM sqlite_master
             WHERE type IN ('table', 'virtual table')
               AND name IN ('threads', 'messages', 'runs', 'run_steps', 'memories', 'memory_fts')
           ORDER BY name`,
        )
        .all() as Array<{ name: string }>;
      expect(tables.map(table => table.name)).toEqual([
        'memories',
        'memory_fts',
        'messages',
        'run_steps',
        'runs',
        'threads',
      ]);

      expect(runMigrations(persistence.sqlite)).toEqual({ applied: [], currentVersion: 5 });
      expect(getAppliedMigrations(persistence.sqlite)).toHaveLength(5);
      expect(persistence.sqlite.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 });
    } finally {
      persistence.close();
    }
  });

  it('upgrades older memory rows without losing content and backfills provenance', () => {
    const persistence = new PersistenceDatabase(':memory:', { migrate: false });
    try {
      runMigrations(persistence.sqlite, migrations.slice(0, 4));
      persistence.sqlite.prepare(`INSERT INTO memories
        (id, content, kind, importance, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run('legacy-memory', 'The durable project convention.', 'instruction', 0.8,
          JSON.stringify({ source: 'automatic-user-memory' }), '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z');

      expect(runMigrations(persistence.sqlite)).toEqual({
        applied: [{ version: 5, name: 'persistent-memory-provenance-and-keys' }],
        currentVersion: 5,
      });
      const memories = new MemoryRepository(persistence.sqlite);
      expect(memories.getById('legacy-memory')).toMatchObject({
        id: 'legacy-memory',
        content: 'The durable project convention.',
        source: 'passive-extraction',
      });
      expect(memories.search('project convention')).toHaveLength(1);
    } finally {
      persistence.close();
    }
  });

  it('enables foreign-key cascades for thread-owned records', () => {
    const persistence = testDatabase();
    try {
      const thread = persistence.threads.create({ title: 'Cascade me' });
      persistence.messages.create({ threadId: thread.id, role: 'user', content: 'hello' });
      const run = persistence.runs.create({ threadId: thread.id, goal: 'test', criteria: [] });
      const step = persistence.runSteps.create({ runId: run.id, phase: 'observe' });

      expect(persistence.threads.delete(thread.id)).toBe(true);
      expect(persistence.messages.countByThread(thread.id)).toBe(0);
      expect(persistence.runs.getById(run.id)).toBeUndefined();
      expect(persistence.runSteps.getById(step.id)).toBeUndefined();
    } finally {
      persistence.close();
    }
  });
});
