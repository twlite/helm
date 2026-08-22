import type { Hono } from 'hono';
import { config, defaultModel, embedding, modelCatalog } from '../config.ts';
import { getEffectiveSummaryContext } from '../services/model-context.ts';

export const registerInfoRoute = (app: Hono) => {
  app.get('/api/info', async (c) => {
    const models = await Promise.all(
      modelCatalog.map(async (model) => {
        const context = await getEffectiveSummaryContext({
          baseUrl: model.baseUrl,
          configuredContextWindowTokens: model.contextWindowTokens,
          fallbackTriggerTokens: config.SUMMARY_TRIGGER_TOKENS,
          modelId: model.model,
        });

        return {
          capabilities: model.capabilities,
          contextWindowSource: context.source,
          contextWindowTokens: context.contextWindowTokens,
          description: model.description,
          favorite: model.favorite,
          id: model.id,
          label: model.label,
          maxOutputTokens: model.maxOutputTokens,
          model: model.model,
          provider: model.provider,
          providerLabel: model.providerLabel,
          reasoning: model.reasoning,
          shortcut: model.shortcut,
          summaryTriggerTokens: context.triggerTokens,
        };
      }),
    );

    const selectedModel = models.find((model) => model.id === defaultModel.id);
    const summaryTriggerTokens =
      selectedModel?.summaryTriggerTokens ?? config.SUMMARY_TRIGGER_TOKENS;

    return c.json({
      contextWindowTokens: selectedModel?.contextWindowTokens ?? null,
      defaultModelId: defaultModel.id,
      embedModel: embedding.model,
      embedProvider: embedding.provider,
      model: defaultModel.model,
      models,
      provider: defaultModel.provider,
      summaryTriggerSource: selectedModel?.contextWindowSource ?? 'fallback',
      summaryTriggerTokens,
    });
  });
};
