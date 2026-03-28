import { ChromaClient } from 'chromadb';
import type { Collection } from 'chromadb';
import { config } from '../config.ts';

export const chroma = new ChromaClient({
  path: config.CHROMA_URL,
});

const collectionCache = new Map<string, Promise<Collection>>();

export const getCollection = async (name: string): Promise<Collection> => {
  const cached = collectionCache.get(name);
  if (cached) {
    return cached;
  }

  const promise = chroma.getOrCreateCollection({ name });
  collectionCache.set(name, promise);
  return promise;
};
