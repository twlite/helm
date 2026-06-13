import type { Hono } from 'hono';
import { registerConversationRoutes } from './conversations.ts';
import { registerHealthRoutes } from './health.ts';
import { registerInfoRoute } from './info.ts';
import { registerMemoryRoutes } from './memories.ts';
import { registerRootRoute } from './root.ts';
import { registerRunRoutes } from './runs.ts';

export const registerRoutes = (app: Hono) => {
  registerHealthRoutes(app);
  registerInfoRoute(app);
  registerMemoryRoutes(app);
  registerConversationRoutes(app);
  registerRunRoutes(app);
  registerRootRoute(app);
};
