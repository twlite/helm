import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '../../src/config.ts';

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

const service = createOpenAICompatible({
  baseURL: config.LLM_BASE_URL,
  name: config.MODEL_PROVIDER,
  transformRequestBody: (body) => {
    const imageUrlPartCount = countImageUrlParts(body);

    if (containsScreenshotMarker(body) && imageUrlPartCount === 0) {
      throw new Error(
        'Latest desktop screenshot was prepared for the model, but the provider request contains no image_url part.',
      );
    }

    return body;
  },
});

export const languageModel = service(config.VLM_MODEL);
export const embedModel = service.embeddingModel(config.EMBED_MODEL);
