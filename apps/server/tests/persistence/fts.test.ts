import { describe, expect, it } from 'bun:test';

import { MemoryRepository } from '../../src/memory/repository';
import { testDatabase } from './helpers';

describe('memory FTS5', () => {
  it('searches memory content and keeps the index synchronized', () => {
    const persistence = testDatabase();
    try {
      const memories = new MemoryRepository(persistence.sqlite);
      const sqlite = memories.create({ content: 'SQLite migrations are durable', kind: 'fact' });
      memories.create({ content: 'The desktop uses XFCE', kind: 'note' });
      const updated = memories.create({ content: 'Temporary browser note', kind: 'note' });

      expect(memories.search('migrations')).toEqual([sqlite]);
      expect(memories.search('desktop')).toHaveLength(1);
      expect(memories.update(updated.id, { content: 'The durable FTS index is tested' })?.content).toContain('durable');
      expect(memories.search('browser')).toEqual([]);
      expect(memories.search('FTS')).toHaveLength(1);
      expect(memories.delete(sqlite.id)).toBe(true);
      expect(memories.search('migrations')).toEqual([]);
    } finally {
      persistence.close();
    }
  });

  it('does not interpret punctuation as an unsafe FTS expression', () => {
    const persistence = testDatabase();
    try {
      const memories = new MemoryRepository(persistence.sqlite);
      const memory = memories.create({ content: 'safe query handling', kind: 'note' });
      expect(memories.search('safe:"query" OR *')).toEqual([]);
      expect(memories.search('safe query')).toEqual([memory]);
    } finally {
      persistence.close();
    }
  });
});
