import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StructuredOutputCompatibility } from './ai/structured-output';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function expandHome(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

const defaultDataDir =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Helm')
    : join(homedir(), '.local', 'share', 'helm');

function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Model configuration field \"${name}\" must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Model configuration field \"${name}\" must be a positive integer`);
  }
  return value;
}

function nonNegativeNumber(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Model configuration field \"${name}\" must be a non-negative number`);
  }
  return value;
}

function contextRatio(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`Model configuration field "${name}" must be greater than 0 and less than 1`);
  }
  return value;
}

export interface HelmModelsConfig {
  providerName: string;
  baseUrl: string;
  apiKey?: string;
  languageModel: string;
  embeddingModel: string;
  embeddingDimensions: number;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  contextWindowTokens: number;
  contextCompactAtRatio: number;
  contextCriticalAtRatio: number;
  contextRecentExchanges: number;
  contextCriticalRecentExchanges: number;
  supportsStructuredOutputs: boolean;
  structuredOutputCompatibility: StructuredOutputCompatibility;
}

interface ModelConfigFile {
  providerName?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  languageModel?: unknown;
  embeddingModel?: unknown;
  embeddingDimensions?: unknown;
  maxOutputTokens?: unknown;
  temperature?: unknown;
  requestTimeoutMs?: unknown;
  contextWindowTokens?: unknown;
  contextCompactAtRatio?: unknown;
  contextCriticalAtRatio?: unknown;
  contextRecentExchanges?: unknown;
  contextCriticalRecentExchanges?: unknown;
  supportsStructuredOutputs?: unknown;
  structuredOutputCompatibility?: unknown;
}

const defaultModelsConfigPath = join(repositoryRoot, 'config', 'models.json');

function loadModelsFile(path: string): ModelConfigFile {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`Unable to read Helm model configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('the root value must be a JSON object');
    }
    return parsed as ModelConfigFile;
  } catch (error) {
    throw new Error(`Invalid Helm model configuration at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function loadModelsConfig(env: NodeJS.ProcessEnv): HelmModelsConfig {
  const path = env.HELM_MODELS_CONFIG ? expandHome(env.HELM_MODELS_CONFIG) : defaultModelsConfigPath;
  const file = loadModelsFile(path);
  const apiKey = typeof file.apiKey === 'string' && file.apiKey.trim().length > 0
    ? file.apiKey.trim()
    : undefined;
  const supportsStructuredOutputs = file.supportsStructuredOutputs === undefined
    ? true
    : file.supportsStructuredOutputs;
  if (typeof supportsStructuredOutputs !== 'boolean') {
    throw new Error('Model configuration field "supportsStructuredOutputs" must be a boolean');
  }
  const structuredOutputCompatibility = env.HELM_LLM_STRUCTURED_OUTPUT_COMPATIBILITY
    ?? file.structuredOutputCompatibility
    ?? 'native';
  if (structuredOutputCompatibility !== 'native' && structuredOutputCompatibility !== 'lmstudio-mlx') {
    throw new Error(
      'Model configuration field "structuredOutputCompatibility" must be "native" or "lmstudio-mlx"',
    );
  }

  const contextCompactAtRatio = contextRatio(
    env.HELM_LLM_CONTEXT_COMPACT_AT_RATIO === undefined ? file.contextCompactAtRatio ?? 0.68 : Number(env.HELM_LLM_CONTEXT_COMPACT_AT_RATIO),
    'contextCompactAtRatio',
  );
  const contextCriticalAtRatio = contextRatio(
    env.HELM_LLM_CONTEXT_CRITICAL_AT_RATIO === undefined ? file.contextCriticalAtRatio ?? 0.86 : Number(env.HELM_LLM_CONTEXT_CRITICAL_AT_RATIO),
    'contextCriticalAtRatio',
  );
  if (contextCriticalAtRatio <= contextCompactAtRatio) {
    throw new Error('Model configuration field "contextCriticalAtRatio" must be greater than "contextCompactAtRatio"');
  }

  return {
    providerName: requiredString(env.HELM_LLM_PROVIDER ?? file.providerName, 'providerName'),
    baseUrl: requiredString(env.HELM_LLM_BASE_URL ?? file.baseUrl, 'baseUrl').replace(/\/$/u, ''),
    ...(env.HELM_LLM_API_KEY?.trim() || apiKey ? { apiKey: env.HELM_LLM_API_KEY?.trim() || apiKey } : {}),
    languageModel: requiredString(env.HELM_LANGUAGE_MODEL ?? file.languageModel, 'languageModel'),
    embeddingModel: requiredString(env.HELM_EMBEDDING_MODEL ?? file.embeddingModel, 'embeddingModel'),
    embeddingDimensions: positiveInteger(
      env.HELM_EMBEDDING_DIMENSIONS === undefined ? file.embeddingDimensions : Number(env.HELM_EMBEDDING_DIMENSIONS),
      'embeddingDimensions',
    ),
    maxOutputTokens: positiveInteger(
      env.HELM_LLM_MAX_OUTPUT_TOKENS === undefined ? file.maxOutputTokens : Number(env.HELM_LLM_MAX_OUTPUT_TOKENS),
      'maxOutputTokens',
    ),
    temperature: nonNegativeNumber(
      env.HELM_LLM_TEMPERATURE === undefined ? file.temperature : Number(env.HELM_LLM_TEMPERATURE),
      'temperature',
    ),
    requestTimeoutMs: positiveInteger(
      env.HELM_LLM_TIMEOUT_MS === undefined ? file.requestTimeoutMs : Number(env.HELM_LLM_TIMEOUT_MS),
      'requestTimeoutMs',
    ),
    contextWindowTokens: positiveInteger(
      env.HELM_LLM_CONTEXT_WINDOW_TOKENS === undefined ? file.contextWindowTokens ?? 32_768 : Number(env.HELM_LLM_CONTEXT_WINDOW_TOKENS),
      'contextWindowTokens',
    ),
    contextCompactAtRatio,
    contextCriticalAtRatio,
    contextRecentExchanges: positiveInteger(
      env.HELM_LLM_CONTEXT_RECENT_EXCHANGES === undefined ? file.contextRecentExchanges ?? 6 : Number(env.HELM_LLM_CONTEXT_RECENT_EXCHANGES),
      'contextRecentExchanges',
    ),
    contextCriticalRecentExchanges: positiveInteger(
      env.HELM_LLM_CONTEXT_CRITICAL_RECENT_EXCHANGES === undefined ? file.contextCriticalRecentExchanges ?? 2 : Number(env.HELM_LLM_CONTEXT_CRITICAL_RECENT_EXCHANGES),
      'contextCriticalRecentExchanges',
    ),
    supportsStructuredOutputs,
    structuredOutputCompatibility,
  };
}

export interface HelmConfig {
  host: string;
  port: number;
  dataDir: string;
  vmDir: string;
  databasePath: string;
  runtimeDir: string;
  runtimeTag: string;
  baseImagePath: string;
  workingImagePath: string;
  efiVariablesPath: string;
  machineIdentifierPath: string;
  provisioningImagePath: string;
  provisioningEfiVariablesPath: string;
  provisioningLockPath: string;
  vmHelperPath: string;
  vmMemoryMb: number;
  vmCpus: number;
  guestHost: string;
  guestPort: number;
  maxSteps: number;
  maxRepeatedAction: number;
  maxConsecutiveFailures: number;
  toolTimeoutMs: number;
  models: HelmModelsConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HelmConfig {
  const dataDir = expandHome(env.HELM_DATA_DIR ?? defaultDataDir);
  const vmDir = join(dataDir, 'vm');
  return {
    host: env.HELM_HOST ?? '127.0.0.1',
    port: numberFromEnv(env, 'HELM_PORT', 8787),
    dataDir,
    vmDir,
    databasePath: env.HELM_DATABASE_PATH
      ? expandHome(env.HELM_DATABASE_PATH)
      : join(dataDir, 'helm.sqlite'),
    runtimeDir: env.HELM_RUNTIME_DIR
      ? expandHome(env.HELM_RUNTIME_DIR)
      : join(dataDir, 'runtime'),
    runtimeTag: env.HELM_VM_RUNTIME_TAG ?? 'helm-runtime',
    baseImagePath: expandHome(env.HELM_VM_BASE_IMAGE ?? join(vmDir, 'base.img')),
    workingImagePath: expandHome(env.HELM_VM_WORKING_IMAGE ?? join(vmDir, 'disk.img')),
    efiVariablesPath: expandHome(env.HELM_VM_EFI_VARS ?? join(vmDir, 'efi-vars.bin')),
    machineIdentifierPath: expandHome(env.HELM_VM_MACHINE_ID ?? join(vmDir, 'machine-id.bin')),
    provisioningImagePath: expandHome(
      env.HELM_VM_PROVISIONING_IMAGE ?? join(vmDir, 'provisioning.img'),
    ),
    provisioningEfiVariablesPath: expandHome(
      env.HELM_VM_PROVISIONING_EFI_VARS ?? join(vmDir, 'provisioning-efi-vars.bin'),
    ),
    provisioningLockPath: expandHome(
      env.HELM_VM_PROVISIONING_LOCK ?? join(vmDir, 'provisioning.lock'),
    ),
    vmHelperPath: expandHome(
      env.HELM_VM_HELPER ?? join(repositoryRoot, 'native', 'helm-vm-host', '.build', 'release', 'helm-vm-host'),
    ),
    vmMemoryMb: numberFromEnv(env, 'HELM_VM_MEMORY_MB', 4096),
    vmCpus: numberFromEnv(env, 'HELM_VM_CPUS', 4),
    guestHost: env.HELM_GUEST_HOST ?? '127.0.0.1',
    guestPort: numberFromEnv(env, 'HELM_GUEST_PORT', 4242),
    maxSteps: numberFromEnv(env, 'HELM_MAX_STEPS', 32),
    maxRepeatedAction: numberFromEnv(env, 'HELM_MAX_REPEATED_ACTION', 3),
    maxConsecutiveFailures: numberFromEnv(env, 'HELM_MAX_CONSECUTIVE_FAILURES', 3),
    toolTimeoutMs: numberFromEnv(env, 'HELM_TOOL_TIMEOUT_MS', 30_000),
    models: loadModelsConfig(env),
  };
}
