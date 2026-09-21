import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { describe, expect, it } from 'bun:test';

import { createHelmApplication } from '../src/server';
import { loadConfig } from '../src/config';

async function readJson<T>(response: Response | undefined): Promise<T> {
  if (!response) throw new Error('Expected an HTTP response');
  return await response.json() as T;
}

describe('Helm HTTP API', () => {
  it('persists threads, messages, memories, and a completed scripted run', async () => {
    const dataDir = join(tmpdir(), `helm-api-${randomUUID()}`);
    const application = createHelmApplication(loadConfig({
      HELM_DATA_DIR: dataDir,
      HELM_DATABASE_PATH: join(dataDir, 'helm.sqlite'),
      HELM_RUNTIME_DIR: join(dataDir, 'runtime'),
      HELM_VM_HELPER: join(dataDir, 'missing-helper'),
      HELM_PORT: '8787',
    }));

    try {
      const health = await readJson<{ ok: boolean; database: boolean; fts5: boolean }>(
        await application.handle(new Request('http://helm.test/api/health')),
      );
      expect(health).toMatchObject({ ok: true, database: true, fts5: true });

      const createdThread = await readJson<{ thread: { id: string } }>(
        await application.handle(new Request('http://helm.test/api/threads', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'API test' }),
        })),
      );
      const threadId = createdThread.thread.id;

      const createdMessage = await readJson<{ message: { id: string } }>(
        await application.handle(new Request(`http://helm.test/api/threads/${threadId}/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'A persisted instruction' }),
        })),
      );
      expect(createdMessage.message.id).toBeString();

      const createdMemory = await readJson<{ memory: { id: string } }>(
        await application.handle(new Request('http://helm.test/api/memories', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ content: 'The API test remembers FTS5', kind: 'fact' }),
        })),
      );
      expect(createdMemory.memory.id).toBeString();

      const search = await readJson<{ memories: Array<{ id: string }> }>(
        await application.handle(new Request('http://helm.test/api/memories/search?q=FTS5')),
      );
      expect(search.memories.some(memory => memory.id === createdMemory.memory.id)).toBe(true);

      const demo = await readJson<{
        run: { status: string; sourceMessageId?: string; steps: Array<{ phase: string }> };
      }>(
        await application.handle(new Request('http://helm.test/api/runs/scripted-demo', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ threadId }),
        })),
      );
      expect(demo.run.status).toBe('completed');
      expect(demo.run.sourceMessageId).toBeString();
      expect(demo.run.steps.some(step => step.phase === 'verify')).toBe(true);
    } finally {
      await application.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
