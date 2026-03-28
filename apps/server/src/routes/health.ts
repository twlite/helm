import type { Hono } from 'hono';

export const registerHealthRoutes = (app: Hono) => {
  app.get('/api/health', (c) => {
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });
};
