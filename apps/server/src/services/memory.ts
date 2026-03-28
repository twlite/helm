import { randomUUID } from 'node:crypto';
import { embed } from 'ai';
import { embedModel } from '../agent/model.ts';
import { config } from '../config.ts';
import { getCollection } from '../database/chroma.ts';
import {
  insertEmbeddingLink,
  listEmbeddingLinksByConversation,
} from '../database/store.ts';

interface UpsertMemoryInput {
  conversationId: string;
  entityType: string;
  entityId: string;
  text: string;
  collectionName?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface RetrievedMemory {
  id: string;
  distance: number | null;
  text: string;
  metadata: Record<string, unknown>;
}

export const upsertMemory = async (input: UpsertMemoryInput): Promise<void> => {
  const cleanText = input.text.trim();
  if (!cleanText) {
    return;
  }

  try {
    const result = await embed({
      model: embedModel,
      value: cleanText,
    });

    const chromaId = randomUUID();
    const collectionName = input.collectionName ?? config.MEMORY_COLLECTION;
    const collection = await getCollection(collectionName);

    await collection.upsert({
      documents: [cleanText],
      embeddings: [result.embedding],
      ids: [chromaId],
      metadatas: [
        {
          conversationId: input.conversationId,
          entityId: input.entityId,
          entityType: input.entityType,
          ...(input.metadata ?? {}),
        },
      ],
    });

    insertEmbeddingLink({
      conversationId: input.conversationId,
      entityId: input.entityId,
      entityType: input.entityType,
      chromaCollection: collectionName,
      chromaId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[memory] Failed to upsert embedding: ${message}`);
  }
};

export const queryMemories = async (input: {
  conversationId: string;
  query: string;
  topK?: number;
  collectionName?: string;
}): Promise<RetrievedMemory[]> => {
  const cleanQuery = input.query.trim();
  if (!cleanQuery) {
    return [];
  }

  try {
    const embeddingResult = await embed({
      model: embedModel,
      value: cleanQuery,
    });

    const collection = await getCollection(
      input.collectionName ?? config.MEMORY_COLLECTION,
    );

    const result = await collection.query({
      include: ['metadatas', 'documents', 'distances'],
      nResults: input.topK ?? config.MEMORY_TOP_K,
      queryEmbeddings: [embeddingResult.embedding],
      where: { conversationId: input.conversationId },
    });

    const ids = result.ids?.[0] ?? [];
    const distances = result.distances?.[0] ?? [];
    const documents = result.documents?.[0] ?? [];
    const metadatas = result.metadatas?.[0] ?? [];

    return ids.map((id, index) => ({
      id,
      distance: typeof distances[index] === 'number' ? distances[index] : null,
      text: documents[index] ?? '',
      metadata:
        metadatas[index] && typeof metadatas[index] === 'object'
          ? (metadatas[index] as Record<string, unknown>)
          : {},
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[memory] Failed to retrieve memories: ${message}`);
    return [];
  }
};

export const deleteConversationMemories = async (
  conversationId: string,
): Promise<void> => {
  const links = listEmbeddingLinksByConversation(conversationId);
  if (links.length === 0) {
    return;
  }

  const grouped = new Map<string, string[]>();

  for (const link of links) {
    const ids = grouped.get(link.chromaCollection) ?? [];
    ids.push(link.chromaId);
    grouped.set(link.chromaCollection, ids);
  }

  for (const [collectionName, ids] of grouped.entries()) {
    try {
      const collection = await getCollection(collectionName);
      await collection.delete({ ids });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[memory] Failed to delete embeddings for conversation ${conversationId} in ${collectionName}: ${message}`,
      );
    }
  }
};
