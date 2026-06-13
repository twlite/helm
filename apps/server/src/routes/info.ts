import type { Hono } from 'hono';
import { config } from '../config.ts';
import { getEffectiveSummaryContext } from '../services/model-context.ts';

export const registerInfoRoute = (app: Hono) => {
  app.get('/api/info', async (c) => {
    const summaryContext = await getEffectiveSummaryContext({
      baseUrl: config.LLM_BASE_URL,
      fallbackTriggerTokens: config.SUMMARY_TRIGGER_TOKENS,
      modelId: config.VLM_MODEL,
    });

    return c.json({
      contextWindowTokens: summaryContext.contextWindowTokens,
      embedModel: config.EMBED_MODEL,
      model: config.VLM_MODEL,
      provider: config.MODEL_PROVIDER,
      summaryTriggerSource: summaryContext.source,
      summaryTriggerTokens: summaryContext.triggerTokens,
    });
  });
};
