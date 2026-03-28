import type { Hono } from 'hono';

export const registerRootRoute = (app: Hono) => {
  app.get('/', (c) => {
    return c.json({
      message: 'Helm server is running',
      routes: [
        '/api/health',
        '/api/conversations',
        '/api/conversations/:conversationId',
        '/api/conversations/:conversationId/messages',
        '/api/conversations/:conversationId/events',
        '/api/conversations/:conversationId/runs',
        '/api/conversations/:conversationId/runs/:runId/cancel',
        '/api/conversations/:conversationId/runs/:runId/stream',
      ],
    });
  });
};
