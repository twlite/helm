import { describe, expect, it } from 'bun:test';

import { testDatabase } from './helpers';

describe('thread and message persistence', () => {
  it('keeps messages isolated by thread and updates thread recency', () => {
    const persistence = testDatabase();
    try {
      const first = persistence.threads.create({
        id: 'thread-a',
        title: 'A',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const second = persistence.threads.create({
        id: 'thread-b',
        title: 'B',
        createdAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:01.000Z',
      });
      const message = persistence.messages.create({
        id: 'message-a',
        threadId: first.id,
        role: 'assistant',
        content: 'Only A',
        createdAt: '2026-01-01T00:00:02.000Z',
      });

      expect(persistence.messages.listByThread(first.id)).toEqual([message]);
      expect(persistence.messages.listByThread(second.id)).toEqual([]);
      expect(persistence.threads.getById(first.id)?.updatedAt).toBe('2026-01-01T00:00:02.000Z');
      expect(persistence.threads.list(2).map(thread => thread.id)).toEqual(['thread-a', 'thread-b']);
    } finally {
      persistence.close();
    }
  });

  it('supports all shared message roles and metadata objects', () => {
    const persistence = testDatabase();
    try {
      const thread = persistence.threads.create({ title: 'Roles' });
      for (const [index, role] of (['user', 'assistant', 'system', 'tool'] as const).entries()) {
        persistence.messages.create({
          threadId: thread.id,
          role,
          content: role,
          metadata: { index },
          createdAt: `2026-01-01T00:00:0${index}.000Z`,
        });
      }
      expect(persistence.messages.listByThread(thread.id).map(message => message.role)).toEqual([
        'user',
        'assistant',
        'system',
        'tool',
      ]);
    } finally {
      persistence.close();
    }
  });
});
