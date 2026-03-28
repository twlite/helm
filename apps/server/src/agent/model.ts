import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { config } from '../../src/config.ts';

const service = createOpenAICompatible({
  baseURL: config.LLM_BASE_URL,
  name: config.MODEL_PROVIDER,
});

export const languageModel = service(config.VLM_MODEL);
export const embedModel = service.embeddingModel(config.EMBED_MODEL);
