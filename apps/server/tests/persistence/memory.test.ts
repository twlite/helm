import { describe, expect, it } from 'bun:test';

import { buildMemoryRetrievalQuery } from '../../src/memory/retrieval-query';
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

  constructor(private matches: Array<{ memoryId: string; distance: number }>) {}

  setMatches(matches: Array<{ memoryId: string; distance: number }>): void {
    this.matches = matches;
  }

  async upsert(): Promise<void> {}

  async search(): Promise<Array<{ memoryId: string; distance: number }>> {
    return this.matches;
  }

  async remove(): Promise<void> {}
}

describe('persistent memory service', () => {
  it('uses FTS when vector retrieval is unavailable and synchronizes edits and deletion', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite);
      const memory = await service.saveText('Use semantic tools before screenshots', 'instruction');
      expect(service.vectorIndex.available).toBe(false);
      await expect(service.search('semantic tools')).resolves.toEqual([memory]);

      const updated = await service.update(memory.id, { content: 'Use page search before screenshots' });
      expect(updated?.content).toBe('Use page search before screenshots');
      expect(await service.search('semantic tools')).toEqual([]);
      expect(await service.search('page search')).toEqual([updated]);
      expect(await service.delete(memory.id)).toBe(true);
      expect(await service.search('page search')).toEqual([]);
    } finally {
      persistence.close();
    }
  });

  it('uses embeddings and vector adapters when configured', async () => {
    const persistence = testDatabase();
    try {
      const provider = new DeterministicFakeEmbeddingProvider(6);
      const index = new InMemoryMemoryVectorIndex(provider.dimensions);
      const service = new MemoryService(persistence.sqlite, { embeddingProvider: provider, vectorIndex: index });
      const first = await service.saveText('alpha memory', 'fact');
      await service.saveText('unrelated beta memory', 'note');
      expect((await service.search('alpha memory'))[0]?.id).toBe(first.id);
      expect(index.available).toBe(true);
    } finally {
      persistence.close();
    }
  });

  it('fuses FTS and vector candidate ranks before returning recall results', async () => {
    const persistence = testDatabase();
    try {
      const vectorIndex = new FixedRecallIndex([]);
      const provider = new DeterministicFakeEmbeddingProvider(4);
      const service = new MemoryService(persistence.sqlite, { embeddingProvider: provider, vectorIndex });
      const weakFts = service.repository.create({
        id: 'weak-fts',
        content: 'Acme exchange was mentioned in an unrelated note.',
        kind: 'note',
        importance: 0.1,
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const strongVector = service.repository.create({
        id: 'strong-vector',
        content: 'The conversion portal is the useful source for daily values.',
        kind: 'fact',
        importance: 0.9,
        updatedAt: '2026-01-02T00:00:00.000Z',
      });
      const highImportanceIrrelevant = service.repository.create({
        id: 'irrelevant-important',
        content: 'The desk is made from walnut wood.',
        kind: 'fact',
        importance: 1,
      });
      vectorIndex.setMatches([
        { memoryId: strongVector.id, distance: 0.2 },
        { memoryId: highImportanceIrrelevant.id, distance: 1.4 },
      ]);

      const result = await service.recall('Acme exchange values', { limit: 3, candidateLimit: 24 });
      expect(result.map(memory => memory.id)).toEqual(['strong-vector', 'weak-fts']);
      expect(result).not.toContainEqual(expect.objectContaining({ id: 'irrelevant-important' }));
    } finally {
      persistence.close();
    }
  });

  it('lets importance break close vector matches without admitting distant irrelevant memories', async () => {
    const persistence = testDatabase();
    try {
      const vectorIndex = new FixedRecallIndex([]);
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: new DeterministicFakeEmbeddingProvider(4),
        vectorIndex,
      });
      service.repository.create({ id: 'close-low', content: 'Older workstation detail', kind: 'fact', importance: 0.1 });
      service.repository.create({ id: 'close-high', content: 'Preferred workstation detail', kind: 'fact', importance: 0.95 });
      service.repository.create({ id: 'distant-critical', content: 'Important but unrelated', kind: 'fact', importance: 1 });
      vectorIndex.setMatches([
        { memoryId: 'close-low', distance: 0.2 },
        { memoryId: 'close-high', distance: 0.21 },
        { memoryId: 'distant-critical', distance: 1.5 },
      ]);

      const result = await service.recall('Which workstation should run it?', { limit: 3 });
      expect(result.map(memory => memory.id)).toEqual(['close-high', 'close-low']);
    } finally {
      persistence.close();
    }
  });

  it('updates keyed memories in place and removes corrected values from search', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite);
      const first = await service.remember({
        key: 'source:example:data',
        content: 'Use https://legacy-portal.invalid/data for the Acme data source.',
        kind: 'fact',
        source: 'observed',
        sourceUrl: 'https://legacy-portal.invalid/data',
        evidenceIds: ['receipt-old-source'],
        durability: 'refreshable',
      });
      expect(first.action).toBe('remembered');
      expect(first.memory.lastVerifiedAt).toBeString();

      const corrected = await service.remember({
        key: 'source:example:data',
        content: 'Use https://current-source.test/data for the Acme data source.',
        kind: 'fact',
        source: 'user',
        durability: 'refreshable',
      });

      expect(corrected.action).toBe('updated');
      expect(corrected.memory.id).toBe(first.memory.id);
      expect(corrected.memory.source).toBe('user');
      expect(corrected.memory.sourceUrl).toBeUndefined();
      expect(corrected.memory.evidenceIds).toEqual([]);
      expect(corrected.memory.lastVerifiedAt).toBeUndefined();
      expect(service.repository.count()).toBe(1);
      expect(await service.search('legacy-portal')).toEqual([]);
      expect((await service.search('current-source'))[0]?.id).toBe(first.memory.id);
    } finally {
      persistence.close();
    }
  });

  it('deduplicates semantically close unkeyed memories but keeps materially different facts', async () => {
    const persistence = testDatabase();
    try {
      const index = new FixedRecallIndex([]);
      const service = new MemoryService(persistence.sqlite, {
        embeddingProvider: { dimensions: 2, embed: async () => new Float32Array([1, 0]) },
        vectorIndex: index,
        dedupeMaxDistance: 0.36,
      });
      const original = service.repository.create({
        id: 'browser-preference',
        content: 'The user prefers a dim display.',
        kind: 'preference',
      });
      index.setMatches([{ memoryId: original.id, distance: 0.2 }]);
      const duplicate = await service.remember({
        content: 'The user likes a dark screen.',
        kind: 'preference',
        source: 'user',
      });
      expect(duplicate.action).toBe('updated');
      expect(duplicate.memory.id).toBe(original.id);
      expect(service.repository.count()).toBe(1);

      index.setMatches([{ memoryId: original.id, distance: 0.9 }]);
      const different = await service.remember({
        content: 'The user prefers a bright display outdoors.',
        kind: 'preference',
        source: 'user',
      });
      expect(different.action).toBe('remembered');
      expect(service.repository.count()).toBe(2);
    } finally {
      persistence.close();
    }
  });

  it('persists provenance and updates access metadata on relevant retrieval', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite);
      const memory = await service.remember({
        key: 'source:acme:portal',
        content: 'Acme data is published on the verified source portal.',
        kind: 'fact',
        importance: 0.8,
        source: 'observed',
        sourceUrl: 'https://example.test/acme',
        evidenceIds: ['receipt-page'],
        durability: 'refreshable',
      });
      expect(memory.memory).toMatchObject({
        key: 'source:acme:portal',
        source: 'observed',
        sourceUrl: 'https://example.test/acme',
        evidenceIds: ['receipt-page'],
        durability: 'refreshable',
        lastVerifiedAt: expect.any(String),
      });
      await service.recall('Acme source portal');
      expect(service.get(memory.memory.id)?.accessCount).toBe(1);
      expect(service.get(memory.memory.id)?.lastAccessedAt).toBeString();
    } finally {
      persistence.close();
    }
  });

  it('forgets memory from both search and recall', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite);
      const memory = await service.remember({
        key: 'preference:search-engine',
        content: 'The user prefers DuckDuckGo for web searches.',
        kind: 'preference',
      });
      expect(await service.forget({ key: 'preference:search-engine' })).toBe(true);
      expect(await service.search('DuckDuckGo')).toEqual([]);
      expect(await service.recall('web searches')).toEqual([]);
      expect(service.get(memory.memory.id)).toBeUndefined();
    } finally {
      persistence.close();
    }
  });

  it('uses recent subject and assistant results to enrich a generic follow-up query', async () => {
    const persistence = testDatabase();
    try {
      const service = new MemoryService(persistence.sqlite);
      const memory = await service.remember({
        content: 'The official Acme exchange source is https://example.test/acme.',
        kind: 'fact',
        source: 'observed',
        evidenceIds: ['receipt-acme'],
      });
      const conversation = [
        { id: 'old', threadId: 't', role: 'user' as const, content: 'What is the unrelated topic?', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'subject', threadId: 't', role: 'user' as const, content: 'Find the official Acme exchange source.', metadata: {}, createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'result', threadId: 't', role: 'assistant' as const, content: 'The official Acme exchange source is https://example.test/acme.', metadata: {}, createdAt: '2026-01-02T00:00:01.000Z' },
        { id: 'followup', threadId: 't', role: 'user' as const, content: 'Thanks, that answers my question.', metadata: {}, createdAt: '2026-01-02T00:00:02.000Z' },
        { id: 'acknowledgement', threadId: 't', role: 'assistant' as const, content: 'You are welcome.', metadata: {}, createdAt: '2026-01-02T00:00:03.000Z' },
        { id: 'current', threadId: 't', role: 'user' as const, content: 'Use that site again.', metadata: {}, createdAt: '2026-01-03T00:00:00.000Z' },
      ];
      const query = buildMemoryRetrievalQuery('Use that site again.', conversation);
      expect(query).toContain('Current request: Use that site again.');
      expect(query).toContain('Acme exchange source');
      expect(query).not.toContain('unrelated topic');
      await expect(service.recall(query)).resolves.toContainEqual(expect.objectContaining({ id: memory.memory.id }));
    } finally {
      persistence.close();
    }
  });
});
