import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { z } from 'zod';

import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import { ToolRegistry } from '../../src/tools/tool-registry';

describe('ToolRegistry', () => {
  it('validates inputs, returns a common result envelope, and records invocations', async () => {
    const registry = new ToolRegistry({ idFactory: () => 'invocation-1' });
    registry.register({
      name: 'echo',
      description: 'Echo a string.',
      inputSchema: z.object({ value: z.string() }),
      execute: async input => ({ value: input.value }),
    });

    const invalid = await registry.execute('echo', { value: 42 });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const valid = await registry.execute('echo', { value: 'hello' });
    expect(valid).toEqual({ ok: true, data: { value: 'hello' } });
    expect(registry.invocations).toHaveLength(2);
    expect(registry.invocations[1]?.result).toEqual(valid);
  });

  it('returns a timeout result and aborts the handler signal', async () => {
    const registry = new ToolRegistry();
    let aborted = false;
    registry.register({
      name: 'slow',
      description: 'A deliberately slow tool.',
      inputSchema: z.object({}),
      timeoutMs: 10,
      execute: async (_input, context) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          context.signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
        return 'unreachable';
      },
    });

    const result = await registry.execute('slow', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_TIMEOUT' } });
    expect(aborted).toBe(true);
  });

  it('distinguishes file creation, changed writes, and byte-identical successful writes in receipts', async () => {
    const guest = new MockGuestTransport({
      initialFiles: {
        'updated.txt': 'OLD',
        'identical.txt': 'SAME',
      },
    });
    const tools = createGuestToolRegistry(guest);
    const oldHash = createHash('sha256').update('OLD', 'utf8').digest('hex');
    const sameHash = createHash('sha256').update('SAME', 'utf8').digest('hex');

    const created = await tools.execute('fs.write', { path: 'created.txt', content: 'NEW' });
    expect(created).toMatchObject({
      ok: true,
      data: { existedBefore: false, changed: true },
      evidence: { receipt: { effect: { existsBefore: false, existsAfter: true, changed: true, writePerformed: true } } },
    });

    const updated = await tools.execute('fs.write', { path: 'updated.txt', content: 'NEW' });
    expect(updated).toMatchObject({
      ok: true,
      data: { existedBefore: true, beforeSha256: oldHash, changed: true },
      evidence: { receipt: { effect: { changed: true, beforeSha256: oldHash, writePerformed: true } } },
    });

    const identical = await tools.execute('fs.write', { path: 'identical.txt', content: 'SAME' });
    expect(identical).toMatchObject({
      ok: true,
      data: { existedBefore: true, beforeSha256: sameHash, sha256: sameHash, changed: false },
      evidence: { receipt: { ok: true, tool: 'fs.write', effect: { changed: false, writePerformed: true, sha256: sameHash } } },
    });
  });
});
