import { describe, expect, it } from 'bun:test';

import { extractRelevantPassages, rankPageRegions, sampleReadableText, type IndexedBrowserRegion } from '../src/browser-perception';

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

  it('gives table headers stronger evidence than incidental body prose', () => {
    const result = rankPageRegions({
      query: 'currency unit buying selling',
      regions: [
        {
          ref: 'r1-1',
          kind: 'text',
          searchText: 'The page discusses currency, unit sizes, buying habits, and selling trends in an unrelated article.',
          domOrder: 0,
        },
        {
          ref: 'r1-2',
          kind: 'table',
          searchText: 'USD one 132.10 132.70',
          tableHeaders: ['Currency', 'Unit', 'Buying', 'Selling'],
          domOrder: 1,
        },
      ],
    });

    expect(result.results.map(region => region.ref)).toEqual(['r1-2', 'r1-1']);
  });

  it('uses form labels as a high-density match field', () => {
    const result = rankPageRegions({
      query: 'email verification code',
      regions: [
        {
          ref: 'r1-1',
          kind: 'text',
          searchText: 'This article mentions email, verification, and code in separate unrelated examples.',
          domOrder: 0,
        },
        {
          ref: 'r1-2',
          kind: 'form',
          searchText: 'Submit the form to continue.',
          formLabels: ['Email', 'Verification code'],
          domOrder: 1,
        },
      ],
    });

    expect(result.results[0]?.ref).toBe('r1-2');
  });

  it('uses IDF weighting so several common query terms do not beat one distinctive match', () => {
    const regions: IndexedBrowserRegion[] = Array.from({ length: 7 }, (_, index) => ({
      ref: `r1-${index + 1}`,
      kind: 'text',
      searchText: 'rates currency financial information',
      domOrder: index,
    }));
    regions.push({
      ref: 'r1-8',
      kind: 'article',
      heading: 'Cobalt',
      searchText: 'A distinctive cobalt reference appears here.',
      domOrder: 8,
    });

    const result = rankPageRegions({ query: 'rates currency cobalt', regions });
    expect(result.results[0]?.ref).toBe('r1-8');
  });

  it('deduplicates nested region matches and prefers a matching table', () => {
    const result = rankPageRegions({
      query: 'currency buying selling',
      regions: [
        {
          ref: 'r2-1',
          kind: 'section',
          searchText: 'Exchange rates currency unit buying selling for every listed currency.',
          domOrder: 0,
        },
        {
          ref: 'r2-2',
          kind: 'text',
          searchText: 'Exchange rates currency unit buying selling for every listed currency.',
          ancestorRefs: ['r2-1'],
          domOrder: 1,
        },
        {
          ref: 'r2-3',
          kind: 'table',
          searchText: 'USD one 132.10 132.70',
          tableHeaders: ['Currency', 'Unit', 'Buying', 'Selling'],
          ancestorRefs: ['r2-2', 'r2-1'],
          domOrder: 2,
        },
      ],
    });
    expect(result.results.map(region => region.ref)).toEqual(['r2-3']);
  });

  it('finds a query match near the end of a long text body', () => {
    const text = `${'Earlier unrelated information. '.repeat(150)}\n\nDistinctive Cobalt-719 information appears at the end.`;
    const result = extractRelevantPassages({ text, query: 'Cobalt-719', maxChars: 500 });
    expect(result.text).toContain('Cobalt-719');
    expect(result.text).not.toContain('Earlier unrelated information.');
    expect(result.text.length).toBeLessThanOrEqual(500);
  });
});
