import { describe, expect, it } from 'bun:test';

import {
  calculateMemoryRelevance,
  cosineSimilarity,
  DEFAULT_MEMORY_RECENCY_LAMBDA,
  DEFAULT_MEMORY_RELEVANCE_WEIGHTS,
  recencyScore,
} from '../../src/memory/relevance';

describe('memory relevance scoring', () => {
  it('computes full cosine similarity for non-normalized vectors', () => {
    expect(cosineSimilarity([3, 4], [6, 8])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosineSimilarity([2, -3], [-4, 6])).toBeCloseTo(-1);
  });

  it('returns zero for zero-norm and empty vectors', () => {
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([0, 0]))).toBe(0);
  });

  it('rejects mismatched vector dimensions', () => {
    expect(() => cosineSimilarity([1, 2], [1])).toThrow(RangeError);
  });

  it('gives recent memories a higher recency score and clamps future age to zero', () => {
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const recent = recencyScore(now, { now });
    const old = recencyScore(now - 30 * 24 * 60 * 60 * 1_000, { now });
    const future = recencyScore(now + 5 * 24 * 60 * 60 * 1_000, { now });
    expect(recent).toBe(1);
    expect(recent).toBeGreaterThan(old);
    expect(future).toBe(1);
    expect(DEFAULT_MEMORY_RECENCY_LAMBDA).toBe(0.03);
  });

  it('lets a large semantic advantage outweigh maximal recency advantage', () => {
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const oldExactMatch = calculateMemoryRelevance([1, 0], {
      embedding: [8, 0],
      createdAt: '2021-01-01T00:00:00.000Z',
      importance: 0.5,
    }, { now });
    const recentOrthogonalMatch = calculateMemoryRelevance([1, 0], {
      embedding: [0, 9],
      createdAt: now,
      importance: 0.5,
    }, { now });
    expect(oldExactMatch).toBeGreaterThan(recentOrthogonalMatch);
    expect(oldExactMatch).toBeCloseTo(0.75);
    expect(recentOrthogonalMatch).toBeCloseTo(0.25);
  });

  it('uses the exported weights and neutral, clamped importance values', () => {
    expect(DEFAULT_MEMORY_RELEVANCE_WEIGHTS).toEqual({ semantic: 0.7, recency: 0.2, importance: 0.1 });
    const now = Date.parse('2026-01-10T00:00:00.000Z');
    const base = { embedding: [1, 0], createdAt: now };
    expect(calculateMemoryRelevance([1, 0], base, { now })).toBeCloseTo(0.95);
    expect(calculateMemoryRelevance([1, 0], { ...base, importance: 2 }, { now })).toBeCloseTo(1);
    expect(calculateMemoryRelevance([1, 0], { ...base, importance: -1 }, { now })).toBeCloseTo(0.9);
    expect(calculateMemoryRelevance([1, 0], base, {
      now,
      lambda: 0,
      weights: { semantic: 1, recency: 0, importance: 0 },
    })).toBe(1);
  });
});
