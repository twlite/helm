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
    });
  });

  it('allows environment overrides without changing the checked-in model file', () => {
    const config = loadConfig({
      HELM_LLM_BASE_URL: 'http://localhost:4321/v1/',
      HELM_LANGUAGE_MODEL: 'local/test-model',
      HELM_EMBEDDING_DIMENSIONS: '4',
    });

    expect(config.models.baseUrl).toBe('http://localhost:4321/v1');
    expect(config.models.languageModel).toBe('local/test-model');
    expect(config.models.embeddingDimensions).toBe(4);
  });

  it('derives separate provisioning artifacts from the VM data directory', () => {
    const config = loadConfig({
      HELM_DATA_DIR: '/tmp/helm-test-data',
    });

    expect(config.provisioningImagePath).toBe('/tmp/helm-test-data/vm/provisioning.img');
    expect(config.provisioningEfiVariablesPath).toBe('/tmp/helm-test-data/vm/provisioning-efi-vars.bin');
    expect(config.provisioningLockPath).toBe('/tmp/helm-test-data/vm/provisioning.lock');
    expect(config.machineIdentifierPath).toBe('/tmp/helm-test-data/vm/machine-id.bin');
  });
});
