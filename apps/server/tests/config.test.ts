import { describe, expect, it } from 'bun:test';

import { loadConfig } from '../src/config';

describe('Helm model configuration', () => {
  it('loads the checked-in LM Studio models', () => {
    const config = loadConfig({});

    expect(config.models).toMatchObject({
      providerName: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      languageModel: 'google/gemma-4-e2b',
      embeddingModel: 'text-embedding-nomic-embed-text-v1.5',
      embeddingDimensions: 768,
      structuredOutputCompatibility: 'lmstudio-mlx',
      contextWindowTokens: 32_768,
      contextCompactAtRatio: 0.68,
      contextCriticalAtRatio: 0.86,
      contextRecentExchanges: 6,
      contextCriticalRecentExchanges: 2,
    });
  });

  it('allows environment overrides without changing the checked-in model file', () => {
    const config = loadConfig({
      HELM_LLM_BASE_URL: 'http://localhost:4321/v1/',
      HELM_LANGUAGE_MODEL: 'local/test-model',
      HELM_EMBEDDING_DIMENSIONS: '4',
      HELM_LLM_CONTEXT_WINDOW_TOKENS: '16384',
      HELM_LLM_CONTEXT_COMPACT_AT_RATIO: '0.7',
      HELM_LLM_CONTEXT_CRITICAL_AT_RATIO: '0.9',
      HELM_LLM_CONTEXT_RECENT_EXCHANGES: '4',
      HELM_LLM_CONTEXT_CRITICAL_RECENT_EXCHANGES: '1',
    });

    expect(config.models.baseUrl).toBe('http://localhost:4321/v1');
    expect(config.models.languageModel).toBe('local/test-model');
    expect(config.models.embeddingDimensions).toBe(4);
    expect(config.models.contextWindowTokens).toBe(16_384);
    expect(config.models.contextCompactAtRatio).toBe(0.7);
    expect(config.models.contextCriticalAtRatio).toBe(0.9);
    expect(config.models.contextRecentExchanges).toBe(4);
    expect(config.models.contextCriticalRecentExchanges).toBe(1);
  });

  it('rejects context thresholds that cannot be applied in order', () => {
    expect(() => loadConfig({
      HELM_LLM_CONTEXT_COMPACT_AT_RATIO: '0.9',
      HELM_LLM_CONTEXT_CRITICAL_AT_RATIO: '0.8',
    })).toThrow('contextCriticalAtRatio');
  });

  it('derives separate provisioning artifacts from the VM data directory', () => {
    const config = loadConfig({
      HELM_DATA_DIR: '/tmp/helm-test-data',
    });

    expect(config.vmDir).toBe('/tmp/helm-test-data/vm');
    expect(config.runtimeTag).toBe('helm-runtime');
    expect(config.provisioningImagePath).toBe('/tmp/helm-test-data/vm/provisioning.img');
    expect(config.provisioningEfiVariablesPath).toBe('/tmp/helm-test-data/vm/provisioning-efi-vars.bin');
    expect(config.provisioningLockPath).toBe('/tmp/helm-test-data/vm/provisioning.lock');
    expect(config.machineIdentifierPath).toBe('/tmp/helm-test-data/vm/machine-id.bin');
  });
});
