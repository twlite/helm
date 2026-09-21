import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGuestHttpHandler } from '../src/server';
import { GuestRuntime } from '../src/runtime';
import { GuestSandbox } from '../src/sandbox';

describe('helm-guest RPC', () => {
  it('answers handshake requests and returns structured validation errors', async () => {
    const runtime = new GuestRuntime();
    try {
      const handshake = await runtime.dispatch({ id: 'handshake-1', method: 'guest.handshake', params: {} });
      expect(handshake.ok).toBe(true);
      if (handshake.ok) expect(handshake.result).toMatchObject({ runtime: 'helm-guest', protocolVersion: 1 });

      const rejected = await runtime.dispatch({ id: 'bad-1', method: 'fs.write', params: { path: '/tmp/nope', content: 'x' } });
      expect(rejected.ok).toBe(false);
      if (!rejected.ok) expect(rejected.error.code).toBe('FILE_OUTSIDE_SANDBOX');
    } finally {
      await runtime.close();
    }
  });

  it('serves the same protocol over the HTTP handler', async () => {
    const runtime = new GuestRuntime();
    try {
      const handler = createGuestHttpHandler({ runtime });
      const response = await handler(new Request('http://guest.test/rpc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: 'http-1', method: 'guest.handshake', params: {} }),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: 'http-1', ok: true });
    } finally {
      await runtime.close();
    }
  });

  it('returns host-compatible filesystem result envelopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-guest-'));
    const runtime = new GuestRuntime({
      sandbox: new GuestSandbox({ root, workspace: join(root, 'workspace') }),
    });

    try {
      const write = await runtime.dispatch({
        id: 'write-1',
        method: 'fs.write',
        params: { path: 'demo.txt', content: 'hello' },
      });
      expect(write).toMatchObject({
        id: 'write-1',
        ok: true,
        result: { size: 5 },
      });

      const read = await runtime.dispatch({
        id: 'read-1',
        method: 'fs.read',
        params: { path: 'demo.txt' },
      });
      expect(read).toMatchObject({
        id: 'read-1',
        ok: true,
        result: { content: 'hello', size: 5 },
      });

      const stat = await runtime.dispatch({
        id: 'stat-1',
        method: 'fs.stat',
        params: { path: 'demo.txt' },
      });
      expect(stat).toMatchObject({
        id: 'stat-1',
        ok: true,
        result: { exists: true, type: 'file' },
      });

      const rootStat = await runtime.dispatch({
        id: 'stat-root',
        method: 'fs.stat',
        params: { path: root },
      });
      expect(rootStat).toMatchObject({
        id: 'stat-root',
        ok: true,
        result: { exists: true, type: 'directory' },
      });

      const list = await runtime.dispatch({
        id: 'list-1',
        method: 'fs.list',
        params: { path: '.' },
      });
      expect(list).toMatchObject({
        id: 'list-1',
        ok: true,
        result: { entries: ['demo.txt'] },
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
