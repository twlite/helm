import { describe, expect, it } from 'bun:test';

import { SqliteVecMemoryVectorIndex } from '../../src/memory/vector';
import { testDatabase } from './helpers';

describe('sqlite-vec adapter', () => {
  it('reports unavailable instead of crashing when the native extension cannot load', async () => {
    const persistence = testDatabase();
    try {
      const index = new SqliteVecMemoryVectorIndex(persistence.sqlite, { dimensions: 4 });
      if (!index.available) {
        expect(index.loadStatus.available).toBe(false);
        await expect(index.search(new Float32Array([0, 0, 0, 1]), 3)).resolves.toEqual([]);
        await expect(index.upsert('memory-1', new Float32Array([0, 0, 0, 1]))).resolves.toBeUndefined();
        return;
      }

      await index.upsert('near', new Float32Array([1, 0, 0, 0]));
      await index.upsert('far', new Float32Array([0, 0, 1, 0]));
      const matches = await index.search(new Float32Array([1, 0, 0, 0]), 2);
      expect(matches[0]?.memoryId).toBe('near');
      expect(matches[0]?.distance).toBeLessThanOrEqual(matches[1]?.distance ?? Number.POSITIVE_INFINITY);
      await index.remove('near');
      expect((await index.search(new Float32Array([1, 0, 0, 0]), 2)).map(match => match.memoryId)).toEqual(['far']);
    } finally {
      persistence.close();
    }
  });
});
