import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import type { EmbeddingModel, LanguageModel } from 'ai';

import type { HelmConfig } from '../config';
import type { ToolDefinition } from '../tools/registry';
import {
  AiSdkDecisionProvider,
  AiSdkEmbeddingProvider,
  AiSdkMemoryExtractor,
  AiSdkOrchestrator,
  AiSdkResponseGenerator,
  AiSdkTaskPlanner,
  AiSdkThreadTitleGenerator,
  AiSdkWorker,
} from './adapter';

export interface HelmAiModels {
  provider: OpenAICompatibleProvider;
  languageModel: LanguageModel;
  embeddingModel: EmbeddingModel;
  decisionProvider: AiSdkDecisionProvider;
  taskPlanner: AiSdkTaskPlanner;
  orchestrator: AiSdkOrchestrator;
  worker: AiSdkWorker;
  responseGenerator: AiSdkResponseGenerator;
  titleGenerator: AiSdkThreadTitleGenerator;
  memoryExtractor: AiSdkMemoryExtractor;
  embeddingProvider: AiSdkEmbeddingProvider;
}

/** Build the configured LM Studio models without making a network request. */
export function createLmStudioModels(config: HelmConfig, toolDefinitions: readonly ToolDefinition[]): HelmAiModels {
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
    decisionProvider: new AiSdkDecisionProvider({
      ...sharedGenerationOptions,
      toolDefinitions,
    }),
    taskPlanner: new AiSdkTaskPlanner(sharedGenerationOptions),
    orchestrator: new AiSdkOrchestrator(sharedGenerationOptions),
    worker: new AiSdkWorker({
      ...sharedGenerationOptions,
      toolDefinitions,
    }),
    responseGenerator: new AiSdkResponseGenerator({
      model: languageModel,
      maxOutputTokens: config.models.maxOutputTokens,
      temperature: config.models.temperature,
      requestTimeoutMs: config.models.requestTimeoutMs,
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
