import type { Hono } from 'hono';
import { config } from '../config.ts';

export const registerInfoRoute = (app: Hono) => {
  app.get('/api/info', (c) => {
    return c.json({
      embedModel: config.EMBED_MODEL,
      model: config.VLM_MODEL,
      provider: config.MODEL_PROVIDER,
      summaryTriggerTokens: config.SUMMARY_TRIGGER_TOKENS,
    });
  });
};
