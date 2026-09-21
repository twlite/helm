import { describe, expect, it } from 'bun:test';

import { MemoryService } from '../../src/memory/service';
import { DeterministicFakeEmbeddingProvider, InMemoryMemoryVectorIndex, UnavailableMemoryVectorIndex } from '../../src/memory/vector';
import { testDatabase } from './helpers';

describe('persistent memory service', () => {
  it('falls back to FTS when no embedding provider is configured', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite);
      const memory = await service.saveText('Use semantic tools before screenshots', 'instruction');
      expect(service.vectorIndex.available).toBe(false);
      expect(await service.search('semantic tools')).toEqual([memory]);
    } finally {
      persistence.close();
    }
  });

  it('uses the embedding and vector abstractions when configured', async () => {
    const persistence = testDatabase();
    try {
      const provider = new DeterministicFakeEmbeddingProvider(6);
      const index = new InMemoryMemoryVectorIndex(provider.dimensions);
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: provider,
        vectorIndex: index,
      });
      const first = await service.saveText('alpha memory', 'fact');
      await service.saveText('unrelated beta memory', 'note');
      const results = await service.search('alpha memory');
      expect(results[0]?.id).toBe(first.id);
      expect(index.available).toBe(true);
    } finally {
      persistence.close();
    }
  });

  it('does not fail a memory save when vector retrieval is unavailable', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: new DeterministicFakeEmbeddingProvider(),
        vectorIndex: new UnavailableMemoryVectorIndex('test fallback'),
      });
      const memory = await service.saveText('fallback memory', 'note');
      expect(await service.search('fallback')).toEqual([memory]);
    } finally {
      persistence.close();
    }
  });

  it('is deterministic for equal embedding input', async () => {
    const provider = new DeterministicFakeEmbeddingProvider(4);
    const left = await provider.embed('same text');
    const right = await provider.embed('same text');
    expect([...left]).toEqual([...right]);
    expect(left.length).toBe(4);
  });
});
