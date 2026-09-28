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

  it('exposes separate model-facing authored-text and durable-ref write operations', async () => {
    const url = 'https://fixture.example.test/document';
    const guest = new MockGuestTransport({
      pages: {
        [url]: '<!doctype html><html><body><main><h1>Rates</h1><table><caption>Daily rates</caption><tr><th>Currency</th><th>Value</th></tr><tr><td>USD</td><td>133</td></tr></table></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);
    const visibleNames = tools.list().map(tool => tool.name);
    expect(visibleNames).toContain('fs.writeText');
    expect(visibleNames).toContain('fs.writeFromRef');
    expect(visibleNames).not.toContain('fs.write');
    expect(tools.get('fs.writeText')?.inputSchema?.safeParse({ path: 'notes.txt', content: 'hello' }).success).toBe(true);
    expect(tools.get('fs.writeFromRef')?.inputSchema?.safeParse({ path: 'rates.txt', sourceRef: 'd1-12345678-1', format: 'text' }).success).toBe(true);

    await guest.request('browser.navigate', { url });
    const readResult = await tools.execute('browser.read', { mode: 'document', query: 'daily rates' }, { runId: 'export-run' });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error('Expected browser.read to succeed.');
    const read = readResult.data as import('@helm/shared').BrowserReadResult;
    expect(read.documentRef).toBeDefined();
    const authored = await tools.execute('fs.writeText', { path: 'notes.txt', content: 'hello' });
    const staleRun = await tools.execute('fs.writeFromRef', {
      path: 'stale-rates.txt', sourceRef: read.documentRef!, format: 'text',
    }, { runId: 'another-run' });
    expect(staleRun).toMatchObject({
      ok: false,
      error: { code: 'SOURCE_REF_NOT_EXPORTABLE', details: { currentRunEvidence: false } },
    });
    expect(guest.hasFile('/home/helm/workspace/stale-rates.txt')).toBe(false);
    const exported = await tools.execute('fs.writeFromRef', {
      path: 'rates.txt', sourceRef: read.documentRef!, format: 'text',
    }, { runId: 'export-run' });
    expect(authored).toMatchObject({ ok: true, data: { path: '/home/helm/workspace/notes.txt' }, evidence: { receipt: { tool: 'fs.write' } } });
    expect(exported).toMatchObject({
      ok: true,
      data: { sourceType: 'document', sourceTableCount: 1, sourceStructuredBlockCount: 1 },
      evidence: { receipt: { tool: 'fs.write', ok: true } },
    });
    expect(guest.getFile('/home/helm/workspace/notes.txt')).toBe('hello');
    expect(guest.getFile('/home/helm/workspace/rates.txt')).toContain('USD');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual([
      'browser.read', 'fs.writeText', 'fs.writeFromRef', 'fs.writeFromRef',
    ]);
  });

  it('rejects diagnostic browser refs before mutating a file and records a failed write receipt', async () => {
    const url = 'https://fixture.example.test/structured';
    const guest = new MockGuestTransport({
      pages: {
        [url]: `<!doctype html><html><body><main><h1>Market information</h1>
          <table><caption>Market prices</caption><tr><th>Asset</th><th>Price</th></tr><tr><td>Widget</td><td>42</td></tr></table>
          <form><label>Contact <input name="email" type="email"></label></form>
        </main></body></html>`,
      },
      initialFiles: { 'preserved.txt': 'keep this file' },
    });
    const tools = createGuestToolRegistry(guest);
    await guest.request('browser.navigate', { url });
    const readResult = await tools.execute('browser.read', { mode: 'document', query: 'market prices' }, { runId: 'form-ref-run' });
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) throw new Error('Expected browser.read to succeed.');
    const read = readResult.data as import('@helm/shared').BrowserReadResult;
    const formRef = read.diagnostics?.structuredBlocks?.find(block => block.type === 'form')?.ref;
    expect(read.export).toMatchObject({ complete: true, sourceType: 'document', sourceRef: read.documentRef });
    expect(formRef).toBeDefined();

    const rejected = await tools.execute('fs.writeFromRef', {
      path: 'preserved.txt', sourceRef: formRef!, format: 'text',
    }, { runId: 'form-ref-run' });
    expect(rejected).toMatchObject({
      ok: false,
      error: { code: 'SOURCE_REF_NOT_EXPORTABLE', details: { sourceType: 'form', exportable: false } },
      evidence: { receipt: { tool: 'fs.write', ok: false, error: { code: 'SOURCE_REF_NOT_EXPORTABLE' } } },
    });
    expect(rejected.evidence?.receipt?.effect).not.toHaveProperty('writePerformed', true);
    expect(guest.getFile('/home/helm/workspace/preserved.txt')).toBe('keep this file');
  });
});
