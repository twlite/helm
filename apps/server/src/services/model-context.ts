export const SUMMARY_CONTEXT_WINDOW_RATIO = 0.8;
const MODEL_CONTEXT_METADATA_TIMEOUT_MS = 1500;

export type ModelContextSource = 'provider' | 'fallback';

export interface ModelContextResolution {
  contextWindowTokens: number | null;
  source: ModelContextSource;
}

export interface EffectiveSummaryContext {
  contextWindowTokens: number | null;
  source: ModelContextSource;
  triggerTokens: number;
}

const CONTEXT_WINDOW_KEYS = new Set([
  'context_length',
  'context_window',
  'context_window_tokens',
  'max_context',
  'max_context_length',
  'max_context_tokens',
  'max_model_len',
  'max_position_embeddings',
  'max_sequence_length',
  'n_ctx',
]);

const NESTED_METADATA_KEYS = [
  'capabilities',
  'config',
  'details',
  'info',
  'metadata',
  'model_info',
  'parameters',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toPositiveInteger = (value: unknown): number | null => {
  const parsed =
    typeof value === 'string' && value.trim()
      ? Number(value)
      : typeof value === 'number'
        ? value
        : Number.NaN;

  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }

  return Math.floor(parsed);
};

export const extractContextWindowTokens = (
  value: unknown,
  depth = 0,
): number | null => {
  if (!isRecord(value) || depth > 4) {
    return null;
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (!CONTEXT_WINDOW_KEYS.has(key.toLowerCase())) {
      continue;
    }

    const parsed = toPositiveInteger(fieldValue);
    if (parsed) {
      return parsed;
    }
  }

  for (const key of NESTED_METADATA_KEYS) {
    const parsed = extractContextWindowTokens(value[key], depth + 1);
    if (parsed) {
      return parsed;
    }
  }

  return null;
};

const buildModelsUrl = (baseUrl: string): string =>
  new URL('models', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();

const getModelEntries = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (!isRecord(payload)) {
    return [];
  }

  if (Array.isArray(payload.data)) {
    return payload.data;
  }

  if (Array.isArray(payload.models)) {
    return payload.models;
  }

  return [];
};

const getModelName = (value: unknown): string | null => {
  if (!isRecord(value)) {
    return null;
  }

  for (const key of ['id', 'name', 'model']) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
};

const findModelEntry = (entries: unknown[], modelId: string): unknown | null => {
  const exact = entries.find((entry) => getModelName(entry) === modelId);
  if (exact) {
    return exact;
  }

  return entries.length === 1 ? entries[0] : null;
};

export const resolveModelContextWindow = async (args: {
  baseUrl: string;
  fetchFn?: typeof fetch;
  modelId: string;
}): Promise<ModelContextResolution> => {
  const fetchFn = args.fetchFn ?? fetch;
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    MODEL_CONTEXT_METADATA_TIMEOUT_MS,
  );

  try {
    const response = await fetchFn(buildModelsUrl(args.baseUrl), {
      signal: abortController.signal,
    });
    if (!response.ok) {
      return { contextWindowTokens: null, source: 'fallback' };
    }

    const payload = await response.json();
    const entries = getModelEntries(payload);
    const model = findModelEntry(entries, args.modelId);
    const contextWindowTokens = extractContextWindowTokens(model);

    return contextWindowTokens
      ? { contextWindowTokens, source: 'provider' }
      : { contextWindowTokens: null, source: 'fallback' };
  } catch {
    return { contextWindowTokens: null, source: 'fallback' };
  } finally {
    clearTimeout(timeout);
  }
};

export const toSummaryTriggerTokens = (args: {
  fallbackTriggerTokens: number;
  ratio?: number;
  resolvedContextWindowTokens: number | null;
}): number => {
  if (!args.resolvedContextWindowTokens) {
    return args.fallbackTriggerTokens;
  }

  return Math.max(
    1,
    Math.floor(
      args.resolvedContextWindowTokens *
        (args.ratio ?? SUMMARY_CONTEXT_WINDOW_RATIO),
    ),
  );
};

let cachedContextKey: string | null = null;
let cachedContextPromise: Promise<ModelContextResolution> | null = null;

export const clearModelContextWindowCache = (): void => {
  cachedContextKey = null;
  cachedContextPromise = null;
};

export const getEffectiveSummaryContext = async (args: {
  baseUrl: string;
  fallbackTriggerTokens: number;
  fetchFn?: typeof fetch;
  modelId: string;
}): Promise<EffectiveSummaryContext> => {
  const cacheKey = `${args.baseUrl}\n${args.modelId}`;
  if (cachedContextKey !== cacheKey) {
    cachedContextKey = cacheKey;
    cachedContextPromise = null;
  }

  cachedContextPromise ??= resolveModelContextWindow({
    baseUrl: args.baseUrl,
    fetchFn: args.fetchFn,
    modelId: args.modelId,
  });

  const resolved = await cachedContextPromise;
  return {
    ...resolved,
    triggerTokens: toSummaryTriggerTokens({
      fallbackTriggerTokens: args.fallbackTriggerTokens,
      resolvedContextWindowTokens: resolved.contextWindowTokens,
    }),
  };
};
