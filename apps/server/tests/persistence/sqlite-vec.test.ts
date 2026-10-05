import { describe, expect, it } from 'bun:test';

import { SqliteVecMemoryVectorIndex } from '../../src/memory/vector';
import { testDatabase } from './helpers';

describe('sqlite-vec adapter', () => {
  it('reads stored embeddings when available and degrades cleanly otherwise', async () => {
    const persistence = testDatabase();
    try {
      const index = new SqliteVecMemoryVectorIndex(persistence.sqlite, { dimensions: 4 });
      if (!index.available) {
        expect(index.loadStatus.available).toBe(false);
        await expect(index.search(new Float32Array([0, 0, 0, 1]), 3)).resolves.toEqual([]);
        await expect(index.getEmbeddings(['missing'])).resolves.toEqual(new Map());
        await expect(index.upsert('memory-1', new Float32Array([0, 0, 0, 1]))).resolves.toBeUndefined();
        return;
      }

      const nearEmbedding = new Float32Array([1, 0, 0, 0]);
      const farEmbedding = new Float32Array([0, 0, 1, 0]);
      await index.upsert('near', nearEmbedding);
      await index.upsert('far', farEmbedding);
      const matches = await index.search(new Float32Array([1, 0, 0, 0]), 2);
      expect(matches[0]?.memoryId).toBe('near');
      expect(matches[0]?.embedding).toEqual(nearEmbedding);
      expect(matches[0]?.distance).toBeLessThanOrEqual(matches[1]?.distance ?? Number.POSITIVE_INFINITY);
      const stored = await index.getEmbeddings(['near', 'far', 'missing']);
      expect([...stored.keys()].sort()).toEqual(['far', 'near']);
      expect(stored.get('near')).toEqual(nearEmbedding);
      expect(stored.get('far')).toEqual(farEmbedding);
      await index.remove('near');
      expect((await index.search(new Float32Array([1, 0, 0, 0]), 2)).map(match => match.memoryId)).toEqual(['far']);
      expect(await index.getEmbeddings(['near'])).toEqual(new Map());
    } finally {
      persistence.close();
    }
  });
});
