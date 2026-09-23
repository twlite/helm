import { describe, expect, it } from 'bun:test';
import type { ModelMessage } from 'ai';

import {
  estimateContextTokens,
  groupConversation,
  prepareModelContext,
  type ContextExchange,
  type ModelContextSummary,
} from '../../src/ai/context-manager';

function toolExchange(input: {
  tool: string;
  args?: Record<string, unknown>;
  data: Record<string, unknown>;
  receiptId: string;
}): ContextExchange {
  const toolCallId = `call-${input.receiptId}`;
  const result = {
    ok: true,
    data: input.data,
    evidence: {
      receipt: {
        id: input.receiptId,
        tool: input.tool,
        ok: true,
        effect: typeof input.data.url === 'string' ? { urlAfter: input.data.url } : {},
      },
    },
  };
  return {
    kind: 'tool',
    messages: [
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId, toolName: input.tool, input: input.args ?? {} }],
      } as unknown as ModelMessage,
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId, toolName: input.tool, output: { type: 'json', value: result } }],
      } as unknown as ModelMessage,
    ],
  };
}

function noisyPageText(label: string): string {
  return `${label}: ${'Old page detail about unrelated topics. '.repeat(100)}`;
}

describe('model context management', () => {
  it('estimates context from instructions, tool definitions, and serialized messages', () => {
    const short = estimateContextTokens({ instructions: 'role', toolDescription: 'tools', exchanges: [] });
    const long = estimateContextTokens({
      instructions: 'role',
      toolDescription: 'tools',
      exchanges: [{ kind: 'conversation', messages: [{ role: 'user', content: 'x'.repeat(4_000) }] }],
    });
    expect(short).toBeGreaterThan(0);
    expect(long).toBeGreaterThan(short + 1_000);
  });

  it('prunes duplicate observations and compacts old turns with verified state and recent raw turns intact', async () => {
    const currentRequest = 'Save the source data and leave the current page open.';
    const exchanges = groupConversation([{ role: 'user', content: currentRequest }], currentRequest);
    exchanges.push(
      toolExchange({
        tool: 'browser.snapshot',
        args: {},
        data: { url: 'https://example.test/rates', title: 'Rates', revision: 1, outline: [{ ref: 'r1-2', preview: 'old' }] },
        receiptId: 'ev-snapshot-old',
      }),
      toolExchange({
        tool: 'browser.snapshot',
        data: { url: 'https://example.test/rates', title: 'Rates', revision: 2, outline: [{ ref: 'r2-1', preview: 'table' }] },
        receiptId: 'ev-snapshot-current-a',
      }),
      toolExchange({
        tool: 'browser.snapshot',
        data: { url: 'https://example.test/rates', title: 'Rates', revision: 2, outline: [{ ref: 'r2-1', preview: 'table' }] },
        receiptId: 'ev-snapshot-current-b',
      }),
      toolExchange({
        tool: 'browser.searchPage',
        args: { query: 'exchange rates' },
        data: { url: 'https://example.test/rates', title: 'Rates', revision: 1, query: 'exchange rates', results: [{ ref: 'r1-2', kind: 'table' }] },
        receiptId: 'ev-search-old',
      }),
      ...Array.from({ length: 5 }, (_, index) => toolExchange({
        tool: 'browser.inspectRegion',
        args: { ref: `r1-${index + 3}` },
        data: { url: 'https://example.test/rates', title: 'Rates', revision: 1, ref: `r1-${index + 3}`, kind: 'article', format: 'text', text: noisyPageText(`Old inspection ${index}`) },
        receiptId: `ev-inspection-${index}`,
      })),
      toolExchange({
        tool: 'fs.write',
        args: { path: '/home/helm/workspace/rates.json' },
        data: { path: '/home/helm/workspace/rates.json', size: 240 },
        receiptId: 'ev-artifact',
      }),
      toolExchange({
        tool: 'desktop.getState',
        data: { focusedWindow: { title: 'Text Editor' }, windows: [{ title: 'Text Editor' }] },
        receiptId: 'ev-desktop-state',
      }),
      toolExchange({
        tool: 'browser.getState',
        data: { url: 'https://example.test/rates', title: 'Current rates', revision: 2, loading: false, pageCount: 1 },
        receiptId: 'ev-current-state',
      }),
      toolExchange({
        tool: 'browser.inspectRegion',
        args: { ref: 'r2-1' },
        data: { url: 'https://example.test/rates', title: 'Current rates', revision: 2, ref: 'r2-1', kind: 'table', format: 'table', text: 'Recent raw inspection' },
        receiptId: 'ev-current-inspection',
      }),
    );

    let summaryCalls = 0;
    const seenEvidenceIds = new Set<string>();
    const evidenceIdsBySummary: string[][] = [];
    const result = await prepareModelContext({
      exchanges,
      instructions: 'Use tools carefully.',
      currentRequest,
      toolDescription: 'browser and filesystem tools',
      budget: {
        contextWindowTokens: 4_000,
        contextCompactAtRatio: 0.2,
        contextCriticalAtRatio: 0.7,
        contextRecentExchanges: 2,
        contextCriticalRecentExchanges: 1,
      },
      compactionCount: 0,
      summarize: async input => {
        summaryCalls += 1;
        const evidenceIds = input.evidenceCatalog.map(item => item.id);
        evidenceIdsBySummary.push(evidenceIds);
        evidenceIds.forEach(id => seenEvidenceIds.add(id));
        return {
          conversationIntent: ['Keep the saved artifact and inspect the live page.'],
          completed: [
            { description: 'Create the output file.', evidenceIds: ['ev-artifact'] },
            { description: 'Invented completion claim.', evidenceIds: ['not-a-receipt'] },
          ],
          findings: [
            { statement: 'Older page material referenced r1-2.', sourceUrl: 'https://example.test/rates', evidenceIds: ['ev-inspection-0'] },
            { statement: 'Unsupported claim.', sourceUrl: 'https://unverified.test', evidenceIds: ['not-a-receipt'] },
          ],
          unresolved: ['Confirm the newest table without reusing r1-2.'],
          failedApproaches: [],
        } satisfies ModelContextSummary;
      },
    });

    expect(summaryCalls).toBeGreaterThan(0);
    expect(seenEvidenceIds).toContain('ev-inspection-0');
    expect(evidenceIdsBySummary.every(ids => !ids.includes('ev-current-inspection') && !ids.includes('ev-current-state'))).toBe(true);
    expect(result.compaction).toBeDefined();
    expect(result.compaction?.pruning.duplicateBrowserObservations).toBeGreaterThan(0);
    expect(result.compaction?.pruning.supersededBrowserObservations).toBeGreaterThan(0);
    expect(result.compaction?.summary.goal).toBe(currentRequest);
    expect(result.compaction?.summary.findings).toEqual([{
      statement: 'Older page material referenced [expired browser ref].',
      sourceUrl: 'https://example.test/rates',
      evidenceIds: ['ev-inspection-0'],
    }]);
    expect(result.compaction?.summary.completed).toEqual([{
      description: 'Create the output file.',
      evidenceIds: ['ev-artifact'],
    }]);
    expect(result.compaction?.summary.artifacts).toContainEqual(expect.objectContaining({
      path: '/home/helm/workspace/rates.json',
      status: 'created',
      evidenceIds: ['ev-artifact'],
    }));
    expect(result.compaction?.summary.environment).toMatchObject({
      browserUrl: 'https://example.test/rates',
      browserTitle: 'Current rates',
      browserRevision: 2,
      focusedWindow: 'Text Editor',
    });
    expect(result.compaction?.summary.unresolved).toEqual(['Confirm the newest table without reusing [expired browser ref].']);
    expect(result.compaction?.removed.join(' ')).toContain('older exchanges replaced');
    expect(result.compaction?.pruning.obsoleteRefs).toBeGreaterThan(0);

    const flattened = JSON.stringify(result.exchanges.flatMap(exchange => exchange.messages));
    expect(flattened).toContain(currentRequest);
    expect(flattened).toContain('Recent raw inspection');
    expect(flattened).toContain('r2-1');
    expect(flattened).not.toContain('r1-2');
    expect(flattened).not.toMatch(/\b[er]1-\d+\b/u);
    expect(flattened).not.toContain('not-a-receipt');
    expect(flattened).not.toContain('Unsupported claim.');
    expect(result.usage.estimatedTokens).toBeLessThan(4_000);
  });

  it('persists deterministic pruning without calling the summarizer when pruning resolves pressure', async () => {
    const currentRequest = 'Check the current page.';
    const exchanges = groupConversation([{ role: 'user', content: currentRequest }], currentRequest);
    const repeatedOutline = Array.from({ length: 60 }, (_, index) => ({
      ref: `r1-${index + 1}`,
      kind: 'section',
      preview: 'Visible outline content '.repeat(9),
    }));
    exchanges.push(
      toolExchange({
        tool: 'browser.snapshot',
        data: { url: 'https://example.test/', title: 'Example', revision: 1, outline: repeatedOutline },
        receiptId: 'ev-large-snapshot',
      }),
      toolExchange({
        tool: 'browser.snapshot',
        data: { url: 'https://example.test/', title: 'Example', revision: 1, outline: [{ ref: 'r1-1', preview: 'short' }] },
        receiptId: 'ev-small-snapshot',
      }),
    );
    const input = {
      exchanges,
      instructions: 'Use the available tools.',
      currentRequest,
      toolDescription: 'browser tools',
      budget: {
        contextWindowTokens: 10_000,
        contextCompactAtRatio: 0.2,
        contextCriticalAtRatio: 0.8,
        contextRecentExchanges: 2,
        contextCriticalRecentExchanges: 1,
      },
      compactionCount: 0,
      summarize: async () => {
        throw new Error('Mechanical pruning should be enough here.');
      },
    };

    const result = await prepareModelContext(input);
    expect(result.compaction).toMatchObject({
      oldExchangesCompacted: 0,
      compactions: 0,
      pruning: { duplicateBrowserObservations: 1 },
    });
    expect(result.compaction?.summary).toBeUndefined();
    expect(result.compaction?.estimatedTokensAfter).toBeLessThan(result.compaction!.estimatedTokensBefore);
    expect(JSON.stringify(result.exchanges)).not.toContain('Visible outline content');

    const next = await prepareModelContext({ ...input, exchanges: result.exchanges });
    expect(next.compaction).toBeUndefined();
  });

  it('bounds an unexpectedly large structured browser result while preserving table metadata', async () => {
    const currentRequest = 'Read the relevant table rows.';
    const oversized = toolExchange({
      tool: 'browser.inspectRegion',
      args: { ref: 'r3-1', format: 'table' },
      data: {
        url: 'https://example.test/data',
        title: 'Data',
        revision: 3,
        ref: 'r3-1',
        kind: 'table',
        format: 'table',
        columns: ['Code', 'Description'],
        rows: Array.from({ length: 500 }, (_, index) => [`Item ${index}`, 'Long cell value. '.repeat(80)]),
        rowCount: 500,
        returnedRowCount: 500,
        offset: 0,
        columnCount: 2,
        truncated: false,
      },
      receiptId: 'ev-large-table',
    });
    const result = await prepareModelContext({
      exchanges: groupConversation([{ role: 'user', content: currentRequest }], currentRequest).concat(oversized),
      instructions: 'Use structured page regions.',
      currentRequest,
      toolDescription: 'browser tools',
      budget: {
        contextWindowTokens: 100_000,
        contextCompactAtRatio: 0.8,
        contextCriticalAtRatio: 0.95,
        contextRecentExchanges: 4,
        contextCriticalRecentExchanges: 2,
      },
      compactionCount: 0,
      summarize: async () => { throw new Error('No compaction expected.'); },
    });
    const serialized = JSON.stringify(result.exchanges);
    const output = result.exchanges.flatMap(exchange => exchange.messages)
      .flatMap(message => (message as unknown as { content?: Array<Record<string, unknown>> }).content ?? [])
      .find(part => part.type === 'tool-result')?.output as { type?: string; value?: { data?: Record<string, unknown> } } | undefined;
    const data = output?.value?.data;

    expect(serialized.length).toBeLessThan(30_000);
    expect(JSON.stringify(output).length).toBeLessThanOrEqual(24_000);
    expect(data).toMatchObject({
      columns: ['Code', 'Description'],
      rowCount: 500,
      columnCount: 2,
      truncated: true,
      contextTruncated: true,
    });
    expect(data?.rows).toHaveLength(data?.returnedRowCount as number);
    expect((data?.rows as unknown[]).length).toBeLessThan(500);
  });
});
