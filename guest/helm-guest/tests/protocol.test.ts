import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createGuestTcpServer } from '../src/server';
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

  it('serves fragmented and multiple JSONL frames over one TCP connection', async () => {
    const runtime = new GuestRuntime();
    const server = createGuestTcpServer({ runtime, port: 0 });

    try {
      const responses = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const expected = 4;
        const received: Record<string, unknown>[] = [];
        let input = '';
        let settled = false;
        const decoder = new TextDecoder();

        const settle = (callback: () => void) => {
          if (settled) return;
          settled = true;
          callback();
        };

        void Bun.connect({
          hostname: '127.0.0.1',
          port: server.port,
          socket: {
            open(socket) {
              const handshake = `${JSON.stringify({
                id: 'tcp-1',
                method: 'guest.handshake',
                params: {},
              })}\n`;
              socket.write(handshake.slice(0, 7));
              socket.write(handshake.slice(7));

              socket.write([
                JSON.stringify({ id: 'tcp-2', method: 'not-a-method', params: {} }),
                '{"id":"invalid-json"',
                JSON.stringify({ id: 'tcp-3', method: 'guest.handshake', params: {} }),
              ].join('\n') + '\n');
            },
            data(socket, data) {
              input += decoder.decode(data, { stream: true });
              let newlineIndex = input.indexOf('\n');
              while (newlineIndex >= 0) {
                const line = input.slice(0, newlineIndex);
                input = input.slice(newlineIndex + 1);
                try {
                  received.push(JSON.parse(line) as Record<string, unknown>);
                } catch (error) {
                  settle(() => reject(error));
                  socket.end();
                  return;
                }
                if (received.length === expected) {
                  settle(() => resolve(received));
                  socket.end();
                  return;
                }
                newlineIndex = input.indexOf('\n');
              }
            },
            error(socket, error) {
              settle(() => reject(error));
              socket.end();
            },
            close() {
              if (received.length !== expected) {
                settle(() => reject(new Error(`Expected ${expected} responses, got ${received.length}.`)));
              }
            },
          },
        }).catch(error => settle(() => reject(error)));
      });

      expect(responses[0]).toMatchObject({ id: 'tcp-1', ok: true });
      expect(responses[1]).toMatchObject({
        id: 'tcp-2',
        ok: false,
        error: { code: 'METHOD_NOT_FOUND' },
      });
      expect(responses[2]).toMatchObject({
        id: null,
        ok: false,
        error: { code: 'INVALID_JSON' },
      });
      expect(responses[3]).toMatchObject({ id: 'tcp-3', ok: true });
    } finally {
      server.stop(true);
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

  it('creates and verifies an empty directory through the filesystem protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-guest-'));
    const runtime = new GuestRuntime({
      sandbox: new GuestSandbox({ root, workspace: join(root, 'workspace') }),
    });

    try {
      const mkdir = await runtime.dispatch({
        id: 'mkdir-1',
        method: 'fs.mkdir',
        params: { path: 'Desktop/helm-demo' },
      });
      expect(mkdir).toMatchObject({
        id: 'mkdir-1',
        ok: true,
        result: { path: join(root, 'workspace/Desktop/helm-demo'), existedBefore: false },
      });

      const stat = await runtime.dispatch({
        id: 'mkdir-stat-1',
        method: 'fs.stat',
        params: { path: 'Desktop/helm-demo' },
      });
      expect(stat).toMatchObject({
        id: 'mkdir-stat-1',
        ok: true,
        result: { exists: true, type: 'directory' },
      });
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
