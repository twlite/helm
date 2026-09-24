import { describe, expect, it } from 'bun:test';

import { MemoryService } from '../../src/memory/service';
import { registerMemoryTools } from '../../src/memory/tools';
import { ToolRegistry } from '../../src/tools/tool-registry';
import { testDatabase } from '../persistence/helpers';

describe('native memory tools', () => {
  it('requires observed memories to cite successful receipts from the current run', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const tools = new ToolRegistry();
      registerMemoryTools(tools, memory);

      const missingEvidence = await tools.execute('memory.remember', {
        content: 'The Acme values page is useful.',
        kind: 'fact',
        source: 'observed',
        sourceUrl: 'https://example.test/acme',
      });
      expect(missingEvidence).toMatchObject({ ok: false, error: { code: 'MEMORY_EVIDENCE_REQUIRED' } });

      const unknownEvidence = await tools.execute('memory.remember', {
        content: 'The Acme values page is useful.',
        kind: 'fact',
        source: 'observed',
        sourceUrl: 'https://example.test/acme',
        evidenceIds: ['receipt-not-from-this-run'],
      });
      expect(unknownEvidence).toMatchObject({ ok: false, error: { code: 'INVALID_MEMORY_EVIDENCE' } });
      expect(memory.repository.count()).toBe(0);
    } finally {
      persistence.close();
    }
  });

  it('persists observed provenance, supports keyed correction, and forgets the memory', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const tools = new ToolRegistry();
      registerMemoryTools(tools, memory);
      const evidence = [{
        ok: true,
        data: { text: 'The Acme page publishes the current values.' },
        evidence: { receipt: { id: 'receipt-acme-page', ok: true, tool: 'browser.read' } },
      }];

      const saved = await tools.execute('memory.remember', {
        content: 'The Acme values are published at the official portal.',
        kind: 'fact',
        key: 'source:acme:values',
        source: 'observed',
        sourceUrl: 'https://example.test/acme',
        evidenceIds: ['receipt-acme-page'],
        durability: 'refreshable',
      }, { previousResults: evidence });
      expect(saved).toMatchObject({ ok: true, data: { action: 'remembered' } });
      const stored = memory.getByKey('source:acme:values');
      expect(stored).toMatchObject({
        source: 'observed',
        sourceUrl: 'https://example.test/acme',
        evidenceIds: ['receipt-acme-page'],
        durability: 'refreshable',
        lastVerifiedAt: expect.any(String),
      });

      const unsupportedRefresh = await tools.execute('memory.update', {
        key: 'source:acme:values',
        content: 'A purported newer Acme benchmark without evidence.',
      });
      expect(unsupportedRefresh).toMatchObject({ ok: false, error: { code: 'MEMORY_EVIDENCE_REQUIRED' } });
      expect(memory.getByKey('source:acme:values')?.content).toBe('The Acme values are published at the official portal.');

      const updated = await tools.execute('memory.update', {
        key: 'source:acme:values',
        content: 'The updated Acme values portal is the authoritative source.',
        source: 'user',
      });
      expect(updated).toMatchObject({ ok: true, data: { action: 'updated' } });
      expect(memory.getByKey('source:acme:values')).toMatchObject({
        content: 'The updated Acme values portal is the authoritative source.',
        source: 'user',
        evidenceIds: [],
      });

      const forgotten = await tools.execute('memory.forget', { key: 'source:acme:values' });
      expect(forgotten).toMatchObject({ ok: true, data: { deleted: true, key: 'source:acme:values' } });
      expect(memory.getByKey('source:acme:values')).toBeUndefined();
    } finally {
      persistence.close();
    }
  });

  it('returns schema errors and missing-memory failures as structured tool results', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const tools = new ToolRegistry();
      registerMemoryTools(tools, memory);

      const invalid = await tools.execute('memory.update', { key: 'key-only' });
      expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
      const missing = await tools.execute('memory.forget', { id: 'missing-memory' });
      expect(missing).toMatchObject({ ok: false, error: { code: 'MEMORY_NOT_FOUND' } });
    } finally {
      persistence.close();
    }
  });
});
