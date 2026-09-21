import { describe, expect, it } from 'bun:test';

import { getAppliedMigrations, runMigrations } from '../../src/db/migrations';
import { testDatabase } from './helpers';

describe('persistence migrations', () => {
  it('creates all persistence tables and is idempotent', () => {
    const persistence = testDatabase();
    try {
      expect(persistence.migrations.currentVersion).toBe(2);
      expect(persistence.migrations.applied.map(migration => migration.version)).toEqual([1, 2]);

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

      expect(runMigrations(persistence.sqlite)).toEqual({ applied: [], currentVersion: 2 });
      expect(getAppliedMigrations(persistence.sqlite)).toHaveLength(2);
      expect(persistence.sqlite.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 });
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
