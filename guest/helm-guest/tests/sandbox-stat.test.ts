import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'bun:test';

import { GuestSandbox } from '../src/sandbox';

it('hashes current file bytes on explicit stat request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-sandbox-stat-'));
  try {
    const workspace = join(root, 'workspace');
    await mkdir(workspace);
    const sandbox = new GuestSandbox({ root, workspace });
    await sandbox.write('forex.txt', 'USD | 133.20 | 134.10\n');
    const first = await sandbox.stat('forex.txt', true);
    expect(first.sha256).toBe(createHash('sha256').update('USD | 133.20 | 134.10\n').digest('hex'));
    await sandbox.write('forex.txt', 'unrelated replacement');
    const second = await sandbox.stat('forex.txt', true);
    expect(second.sha256).toBe(createHash('sha256').update('unrelated replacement').digest('hex'));
    expect(second.sha256).not.toBe(first.sha256);
    expect((await sandbox.stat('forex.txt')).sha256).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
