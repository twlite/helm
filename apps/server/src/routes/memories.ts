import type { Hono } from 'hono';
import { getCollection } from '../database/chroma.ts';
import {
  deleteEmbeddingLinkById,
  listAllEmbeddingLinks,
} from '../database/store.ts';
import { notFound } from '../errors.ts';

export const registerMemoryRoutes = (app: Hono) => {
  app.get('/api/memories', (c) => {
    const memories = listAllEmbeddingLinks();
    return c.json({ memories });
  });

  app.get('/api/memories/:id/text', async (c) => {
    const id = c.req.param('id');
    const all = listAllEmbeddingLinks();
    const link = all.find((l) => l.id === id);

    if (!link) {
      throw notFound(`Memory entry ${id} was not found.`);
    }

    try {
      const collection = await getCollection(link.chromaCollection);
      const result = await collection.get({
        ids: [link.chromaId],
        include: ['documents'] as never,
      });
      const text = (result.documents?.[0] as string | null) ?? null;
      return c.json({ text });
    } catch {
      return c.json({ text: null });
    }
  });

  app.delete('/api/memories/:id', async (c) => {
    const id = c.req.param('id');
    const all = listAllEmbeddingLinks();
    const link = all.find((l) => l.id === id);

    if (!link) {
      throw notFound(`Memory entry ${id} was not found.`);
    }

    try {
      const collection = await getCollection(link.chromaCollection);
      await collection.delete({ ids: [link.chromaId] });
    } catch {
      // ChromaDB deletion is best-effort
    }

    deleteEmbeddingLinkById(id);
    return new Response(null, { status: 204 });
  });
};
