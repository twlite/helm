import { describe, expect, it } from 'bun:test';

import { extractRelevantPassages, rankPageRegions, sampleReadableText } from '../src/browser-perception';

describe('shared browser perception helpers', () => {
  it('keeps queryless samples within even very small requested character limits', () => {
    for (const limit of [1, 2, 3, 4, 8, 32]) {
      const sample = sampleReadableText('A long opening passage\nA middle passage\nA final passage', limit);
      expect(sample.text.length).toBeLessThanOrEqual(limit);
      expect(sample.truncated).toBe(true);
    }
  });

  it('ranks matching table headers ahead of unrelated page regions', () => {
    const result = rankPageRegions({
      query: 'foreign exchange currency buying selling',
      regions: [
        { ref: 'r1-1', kind: 'article', searchText: 'Local gardening and weather information.', domOrder: 0 },
        {
          ref: 'r1-2',
          kind: 'table',
          searchText: 'USD one 132.10 132.70',
          tableHeaders: ['Currency', 'Unit', 'Buying', 'Selling'],
          domOrder: 10,
        },
      ],
    });
    expect(result.results[0]?.ref).toBe('r1-2');
    expect(result.results[0]?.score).toBeGreaterThan(0);
  });

  it('finds a query match near the end of a long text body', () => {
    const text = `${'Earlier unrelated information. '.repeat(150)}\n\nDistinctive Cobalt-719 information appears at the end.`;
    const result = extractRelevantPassages({ text, query: 'Cobalt-719', maxChars: 500 });
    expect(result.text).toContain('Cobalt-719');
    expect(result.text).not.toContain('Earlier unrelated information.');
    expect(result.text.length).toBeLessThanOrEqual(500);
  });
});
