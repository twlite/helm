import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const optionalUrl = z.preprocess(
  (value) => (typeof value === 'string' && !value.trim() ? undefined : value),
  z.url().optional(),
);

const modelConfigSchema = z
  .object({
    contextWindow: z.coerce.number().int().positive().optional(),
    contextWindowTokens: z.coerce.number().int().positive().optional(),
    description: z.string().trim().min(1).optional(),
    embedding: z.boolean().default(false),
    favorite: z.boolean().default(false),
    label: z.string().trim().min(1).optional(),
    maxOutputTokens: z.coerce.number().int().positive().optional(),
    model: z.string().trim().min(1),
    reasoning: z.boolean().optional(),
    shortcut: z.string().trim().min(1).optional(),
  })
  .passthrough();

const providerConfigSchema = z
  .object({
    apiKey: z.string().trim().min(1).optional(),
    embed: z.string().trim().min(1).nullable().default(null),
    headers: z.record(z.string(), z.string()).optional(),
    label: z.string().trim().min(1).optional(),
    models: z.array(modelConfigSchema).default([]),
    url: z.url(),
  })
  .passthrough();

const helmConfigSchema = z
  .object({
    defaultModel: z.string().trim().min(1).optional(),
    providers: z.record(z.string(), providerConfigSchema),
  })
  .passthrough();

const envSchema = z.object({
  AGENT_MAX_STEPS: z.coerce.number().int().positive().default(50),
  AGENT_CONTEXT_RECENT_MESSAGES: z.coerce.number().int().positive().default(24),
  CHROMA_URL: z.url().default('http://localhost:8000'),
  CLIENT_ORIGIN: optionalUrl,
  DB_PATH: z.string().default('helm.db'),
  EMBED_BASE_URL: optionalUrl,
  EMBED_MODEL: z.string().trim().min(1).optional(),
  EPISODIC_MEMORY_COLLECTION: z.string().default('helm_episodes'),
  HELM_CONFIG_PATH: z.string().trim().min(1).optional(),
  LLM_BASE_URL: optionalUrl,
  MEMORY_COLLECTION: z.string().default('helm_memory'),
  MEMORY_TOP_K: z.coerce.number().int().positive().default(4),
  MODEL_PROVIDER: z.string().trim().min(1).optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  PUBLIC_SERVER_URL: optionalUrl,
  RUN_STREAM_PING_MS: z.coerce.number().int().positive().default(15_000),
  SUMMARY_COLLECTION: z.string().default('helm_summaries'),
  SUMMARY_KEEP_RECENT_MESSAGES: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(10),
  SUMMARY_TRIGGER_TOKENS: z.coerce.number().int().positive().default(9000),
  VLM_MODEL: z.string().trim().min(1).optional(),
});

export interface ModelDefinition {
  apiKey?: string;
  baseUrl: string;
  capabilities?: string[];
  contextWindowTokens: number | null;
  description?: string;
  favorite: boolean;
  headers?: Record<string, string>;
  id: string;
  label: string;
  maxOutputTokens: number | null;
  model: string;
  provider: string;
  providerLabel: string;
  reasoning?: boolean;
  shortcut?: string;
}

export interface EmbeddingDefinition {
  apiKey?: string;
  baseUrl: string;
  headers?: Record<string, string>;
  model: string;
  provider: string;
}

const defaultConfigPath = fileURLToPath(
  new URL('../helm.config.json', import.meta.url),
);

const getConfigPath = (configuredPath: string | undefined): string => {
  if (!configuredPath) {
    return defaultConfigPath;
  }

  return isAbsolute(configuredPath)
    ? configuredPath
    : resolve(process.cwd(), configuredPath);
};

const readHelmConfig = (configPath: string) => {
  if (!existsSync(configPath)) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read Helm config at ${configPath}: ${message}`);
  }

  const parsed = helmConfigSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(
      `Helm config at ${configPath} is invalid: ${parsed.error.issues
        .map((issue) => issue.message)
        .join('; ')}`,
    );
  }

  return parsed.data;
};

const modelLabel = (model: string): string => {
  const lastSegment = model.split('/').at(-1)?.trim();
  return lastSegment || model;
};

const getCapabilities = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const capabilities = value.filter(
    (item): item is string => typeof item === 'string' && item.trim().length > 0,
  );
  return capabilities.length > 0 ? capabilities : undefined;
};

const buildModelDefinitions = (args: {
  providers: Record<string, z.infer<typeof providerConfigSchema>>;
}): ModelDefinition[] => {
  const models: ModelDefinition[] = [];
  const seenIds = new Set<string>();

  for (const [providerName, provider] of Object.entries(args.providers)) {
    for (const model of provider.models) {
      if (model.embedding) {
        continue;
      }

      const id = `${providerName}/${model.model}`;
      if (seenIds.has(id)) {
        throw new Error(`Duplicate model id in Helm config: ${id}`);
      }
      seenIds.add(id);

      models.push({
        apiKey: provider.apiKey,
        baseUrl: provider.url,
        capabilities: getCapabilities(model.capabilities),
        contextWindowTokens:
          model.contextWindowTokens ?? model.contextWindow ?? null,
        description: model.description,
        favorite: model.favorite,
        headers: provider.headers,
        id,
        label: model.label ?? modelLabel(model.model),
        maxOutputTokens: model.maxOutputTokens ?? null,
        model: model.model,
        provider: providerName,
        providerLabel: provider.label ?? providerName,
        reasoning: model.reasoning,
        shortcut: model.shortcut,
      });
    }
  }

  return models;
};

const buildLegacyProvider = (
  env: z.infer<typeof envSchema>,
): z.infer<typeof helmConfigSchema> => {
  const baseUrl = env.LLM_BASE_URL ?? 'http://localhost:1234/v1';
  const provider = env.MODEL_PROVIDER ?? 'openai';
  const model = env.VLM_MODEL ?? 'google/gemma-4-e4b';

  return {
    providers: {
      [provider]: {
        embed: env.EMBED_MODEL ?? 'text-embedding-nomic-embed-text-v1.5',
        models: [{ embedding: false, favorite: false, model }],
        url: baseUrl,
      },
    },
  };
};

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('Invalid server environment configuration');
  console.error(parsedEnv.error.format());
  throw new Error(
    'Server configuration is invalid. Check environment variables.',
  );
}

const env = parsedEnv.data;
const configPath = getConfigPath(env.HELM_CONFIG_PATH);
if (env.HELM_CONFIG_PATH && !existsSync(configPath)) {
  throw new Error(`Helm config was not found at ${configPath}.`);
}
const fileConfig = readHelmConfig(configPath);
const helmConfig = fileConfig ?? buildLegacyProvider(env);
const modelCatalog = buildModelDefinitions({ providers: helmConfig.providers });

if (modelCatalog.length === 0) {
  throw new Error(
    `No chat models are configured in ${configPath}. Add at least one model with "embedding": false.`,
  );
}

const defaultModel = (() => {
  const defaultModelId = helmConfig.defaultModel ?? modelCatalog[0]?.id;
  const model = modelCatalog.find((candidate) => candidate.id === defaultModelId);

  if (!model) {
    throw new Error(
      `The configured defaultModel "${defaultModelId}" does not match a model in ${configPath}.`,
    );
  }

  return model;
})();

const configuredEmbedding = Object.entries(helmConfig.providers).find(
  ([, provider]) => provider.embed,
);

if (!configuredEmbedding) {
  if (fileConfig) {
    throw new Error(
      `No embedding model is configured in ${configPath}. Set providers.<name>.embed to an embedding model, or remove the config file to use legacy environment settings.`,
    );
  }

  throw new Error(
    'No embedding model is configured. Set EMBED_MODEL or providers.<name>.embed.',
  );
}

const [embeddingProviderName, embeddingProvider] = configuredEmbedding;
const embedding: EmbeddingDefinition = {
  apiKey: embeddingProvider.apiKey,
  baseUrl: env.EMBED_BASE_URL ?? embeddingProvider.url ?? defaultModel.baseUrl,
  headers: embeddingProvider.headers,
  model: embeddingProvider.embed as string,
  provider: embeddingProviderName,
};

export const config = {
  ...env,
  EMBED_BASE_URL: embedding.baseUrl,
  EMBED_MODEL: embedding.model,
  HELM_CONFIG_PATH: configPath,
  LLM_BASE_URL: defaultModel.baseUrl,
  MODEL_PROVIDER: defaultModel.provider,
  VLM_MODEL: defaultModel.model,
} as const;

export { defaultModel, embedding, modelCatalog };

export const getModelDefinition = (modelId?: string): ModelDefinition => {
  if (!modelId) {
    return defaultModel;
  }

  const model = modelCatalog.find((candidate) => candidate.id === modelId);
  if (!model) {
    throw new Error(
      `Unknown model "${modelId}". Choose one of: ${modelCatalog
        .map((candidate) => candidate.id)
        .join(', ')}`,
    );
  }

  return model;
};
