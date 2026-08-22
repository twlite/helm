import { createOpenAICompatible, type OpenAICompatibleProvider } from '@ai-sdk/openai-compatible';
import type { EmbeddingModel, LanguageModel } from 'ai';
import {
  embedding,
  getModelDefinition,
  type ModelDefinition,
} from '../config.ts';

const SCREENSHOT_IMAGE_MARKER = 'Latest desktop screenshot image for visual inspection.';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const containsScreenshotMarker = (value: unknown): boolean => {
  if (typeof value === 'string') {
    return value.includes(SCREENSHOT_IMAGE_MARKER);
  }

  if (Array.isArray(value)) {
    return value.some(containsScreenshotMarker);
  }

  if (!isRecord(value)) {
    return false;
  }

  return Object.values(value).some(containsScreenshotMarker);
};

const countImageUrlParts = (value: unknown): number => {
  if (Array.isArray(value)) {
    return value.reduce((count, item) => count + countImageUrlParts(item), 0);
  }

  if (!isRecord(value)) {
    return 0;
  }

  const ownCount = value.type === 'image_url' ? 1 : 0;
  return (
    ownCount +
    Object.values(value).reduce<number>(
      (count, item) => count + countImageUrlParts(item),
      0,
    )
  );
};

const transformRequestBody = (body: Record<string, unknown>) => {
  const imageUrlPartCount = countImageUrlParts(body);

  if (containsScreenshotMarker(body) && imageUrlPartCount === 0) {
    throw new Error(
      'Latest desktop screenshot was prepared for the model, but the provider request contains no image_url part.',
    );
  }

  return body;
};

interface ProviderConnection {
  apiKey?: string;
  baseUrl: string;
  headers?: Record<string, string>;
  provider: string;
}

const providerCache = new Map<string, OpenAICompatibleProvider>();
const languageModelCache = new Map<string, LanguageModel>();

const getProvider = (connection: ProviderConnection): OpenAICompatibleProvider => {
  const cacheKey = [
    connection.provider,
    connection.baseUrl,
    connection.apiKey ?? '',
    JSON.stringify(connection.headers ?? {}),
  ].join('\n');
  const cached = providerCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const provider = createOpenAICompatible({
    apiKey: connection.apiKey,
    baseURL: connection.baseUrl,
    headers: connection.headers,
    includeUsage: true,
    name: connection.provider,
    transformRequestBody,
  });
  providerCache.set(cacheKey, provider);
  return provider;
};

const getModelConnection = (model: ModelDefinition): ProviderConnection => ({
  apiKey: model.apiKey,
  baseUrl: model.baseUrl,
  headers: model.headers,
  provider: model.provider,
});

export const getLanguageModel = (modelId?: string): LanguageModel => {
  const model = getModelDefinition(modelId);
  const cached = languageModelCache.get(model.id);
  if (cached) {
    return cached;
  }

  const languageModel = getProvider(getModelConnection(model)).languageModel(
    model.model,
  );
  languageModelCache.set(model.id, languageModel);
  return languageModel;
};

const embeddingProvider = getProvider({
  apiKey: embedding.apiKey,
  baseUrl: embedding.baseUrl,
  headers: embedding.headers,
  provider: embedding.provider,
});

export const embedModel: EmbeddingModel = embeddingProvider.embeddingModel(
  embedding.model,
);

// Compatibility export for services that use the configured default model.
export const languageModel = getLanguageModel();
