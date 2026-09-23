import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import type { EmbeddingModel, LanguageModel } from 'ai';

import type { HelmConfig } from '../config';
import { AiSdkActingAgent } from './acting-agent';
import {
  AiSdkEmbeddingProvider,
  AiSdkMemoryExtractor,
  AiSdkThreadTitleGenerator,
} from './adapter';

export interface HelmAiModels {
  provider: OpenAICompatibleProvider;
  languageModel: LanguageModel;
  embeddingModel: EmbeddingModel;
  actingAgent: AiSdkActingAgent;
  titleGenerator: AiSdkThreadTitleGenerator;
  memoryExtractor: AiSdkMemoryExtractor;
  embeddingProvider: AiSdkEmbeddingProvider;
}

/** Build the configured LM Studio models without making a network request. */
export function createLmStudioModels(config: HelmConfig): HelmAiModels {
  const provider = createOpenAICompatible({
    name: config.models.providerName,
    baseURL: config.models.baseUrl,
    ...(config.models.apiKey ? { apiKey: config.models.apiKey } : {}),
    includeUsage: true,
    supportsStructuredOutputs: config.models.supportsStructuredOutputs,
  });
  const languageModel = provider.chatModel(config.models.languageModel);
  const embeddingModel = provider.embeddingModel(config.models.embeddingModel);
  const sharedGenerationOptions = {
    model: languageModel,
    maxOutputTokens: config.models.maxOutputTokens,
    temperature: config.models.temperature,
    requestTimeoutMs: config.models.requestTimeoutMs,
    structuredOutputCompatibility: config.models.structuredOutputCompatibility,
  } as const;

  return {
    provider,
    languageModel,
    embeddingModel,
    actingAgent: new AiSdkActingAgent({
      ...sharedGenerationOptions,
    }),
    titleGenerator: new AiSdkThreadTitleGenerator(sharedGenerationOptions),
    memoryExtractor: new AiSdkMemoryExtractor({
      ...sharedGenerationOptions,
      maxOutputTokens: Math.min(config.models.maxOutputTokens, 256),
    }),
    embeddingProvider: new AiSdkEmbeddingProvider({
      model: embeddingModel,
      dimensions: config.models.embeddingDimensions,
      requestTimeoutMs: config.models.requestTimeoutMs,
    }),
  };
}
