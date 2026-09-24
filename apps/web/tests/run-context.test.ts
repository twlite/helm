import { describe, expect, it } from 'bun:test';

import {
  browserInspectionSummary,
  browserSearchDisplay,
  contextCompactionDisplay,
  contextUsageFromEvent,
  contextUsageLabel,
} from '../src/run-context';

describe('run context activity display', () => {
  it('turns live context usage and compaction events into the activity indicator', () => {
    const usage = contextUsageFromEvent('run.context.usage', {
      estimatedTokens: 4_320,
      contextWindowTokens: 32_768,
      compactions: 1,
    });
    expect(usage).toEqual({ estimatedTokens: 4_320, contextWindowTokens: 32_768, compactions: 1 });
    expect(contextUsageLabel(usage!)).toBe('Estimated context 4.3k / 32.8k · Compacted 1×');

    expect(contextUsageFromEvent('run.context.compacted', {
      estimatedTokensAfter: 2_048,
      contextWindowTokens: 32_768,
      compactions: 2,
    }, usage)).toEqual({ estimatedTokens: 2_048, contextWindowTokens: 32_768, compactions: 2 });
  });

  it('prepares the preserved and removed details shown in a compaction activity row', () => {
    const details = contextCompactionDisplay({
      reason: 'Context pressure reached the configured threshold.',
      estimatedTokensBefore: 22_000,
      estimatedTokensAfter: 12_000,
      contextWindowTokens: 32_768,
      oldExchangesCompacted: 9,
      recentExchangesKeptRaw: 4,
      preserved: ['Current user request', '1 evidence-linked finding'],
      removed: ['3 superseded browser observations', '2 obsolete browser refs'],
      summary: {
        findings: [{ statement: 'Rates were read from the active page.', evidenceIds: ['receipt-1'] }],
      },
    });

    expect(details).toEqual({
      reason: 'Context pressure reached the configured threshold.',
      estimatedInput: '22.0k → 12.0k / 32.8k tokens',
      exchanges: '9 older compacted · 4 kept raw',
      preserved: ['Current user request', '1 evidence-linked finding'],
      removed: ['3 superseded browser observations', '2 obsolete browser refs'],
      findings: [{ statement: 'Rates were read from the active page.', evidenceIds: ['receipt-1'] }],
    });
  });

  it('formats targeted page search and region inspection results for activity rows', () => {
    expect(browserSearchDisplay({
      indexedRegionCount: 124,
      matchCount: 1,
      pageReadable: true,
      results: [{ ref: 'r7-18', kind: 'table', heading: 'Daily rates', score: 0.98, preview: 'Currency Unit Buying Selling', snippet: 'USD buying 132.10 selling 132.70' }],
    }, 'currency buying selling')).toEqual({
      query: 'currency buying selling',
      coverage: '124 regions indexed · 1 match · readable page content found',
      matches: 'r7-18 · table · Daily rates · 0.98 · USD buying 132.10 selling 132.70',
    });
    expect(browserInspectionSummary({
      format: 'table',
      heading: 'Foreign Exchange Rates',
      rowCount: 22,
      columnCount: 4,
    })).toBe('Foreign Exchange Rates: Table, 22 rows × 4 columns');
  });
});
