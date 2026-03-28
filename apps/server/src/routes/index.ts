import type { Hono } from 'hono';
import { registerConversationRoutes } from './conversations.ts';
import { registerHealthRoutes } from './health.ts';
import { registerRootRoute } from './root.ts';
import { registerRunRoutes } from './runs.ts';

export const registerRoutes = (app: Hono) => {
  registerHealthRoutes(app);
  registerConversationRoutes(app);
  registerRunRoutes(app);
  registerRootRoute(app);
};
