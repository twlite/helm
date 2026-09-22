import { describe, expect, it } from 'bun:test';

import { MemoryService } from '../../src/memory/service';
import {
  DeterministicFakeEmbeddingProvider,
  InMemoryMemoryVectorIndex,
  UnavailableMemoryVectorIndex,
  type MemoryVectorIndex,
} from '../../src/memory/vector';
import { testDatabase } from './helpers';

class FixedRecallIndex implements MemoryVectorIndex {
  readonly available = true;

  constructor(private readonly matches: Array<{ memoryId: string; distance: number }>) {}

  async upsert(): Promise<void> {}

  async search(): Promise<Array<{ memoryId: string; distance: number }>> {
    return this.matches;
  }

  async remove(): Promise<void> {}
}

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

  it('recalls exact matches and relevant semantic matches without injecting distant vectors', async () => {
    const persistence = testDatabase();
    try {
      const relevant = new MemoryService(persistence.sqlite, {
        embeddingProvider: new DeterministicFakeEmbeddingProvider(4),
        vectorIndex: new FixedRecallIndex([
          { memoryId: 'relevant', distance: 0.2 },
          { memoryId: 'unrelated', distance: 1.4 },
        ]),
      });
      const matching = await relevant.save({
        id: 'relevant',
        content: 'The user prefers the browser to open in a focused window.',
        kind: 'preference',
      });
      await relevant.save({
        id: 'unrelated',
        content: 'The project uses a muted teal accent.',
        kind: 'note',
      });

      await expect(relevant.recall('Open the browser in a focused window')).resolves.toEqual([matching]);
      await expect(relevant.recall('')).resolves.toEqual([]);
    } finally {
      persistence.close();
    }
  });

  it('can recall a semantic-only match when no memory terms overlap the request', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: new DeterministicFakeEmbeddingProvider(4),
        vectorIndex: new FixedRecallIndex([{ memoryId: 'semantic-only', distance: 0.25 }]),
      });
      const memory = await service.save({
        id: 'semantic-only',
        content: 'The workstation runs Ubuntu 24.04 on ARM64.',
        kind: 'fact',
      });

      await expect(service.recall('Which Linux distribution should the virtual machine boot?')).resolves.toEqual([memory]);
    } finally {
      persistence.close();
    }
  });

  it('does not recall a nearest vector for a generic follow-up', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: new DeterministicFakeEmbeddingProvider(4),
        vectorIndex: new FixedRecallIndex([{ memoryId: 'memory', distance: 0.1 }]),
      });
      await service.save({ id: 'memory', content: 'The user prefers a dark desktop.', kind: 'preference' });

      await expect(service.recall('again')).resolves.toEqual([]);
    } finally {
      persistence.close();
    }
  });

  it('falls back to keyword recall when semantic retrieval fails', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: {
          dimensions: 4,
          embed: async () => { throw new Error('embedding service unavailable'); },
        },
        vectorIndex: new FixedRecallIndex([]),
      });
      const memory = await service.saveText('Always verify the downloaded archive', 'instruction');

      await expect(service.recall('Please verify the downloaded archive')).resolves.toEqual([memory]);
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
