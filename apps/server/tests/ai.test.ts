import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed, type EmbeddingModel } from 'ai';
import { describe, expect, it } from 'bun:test';

import { AiSdkEmbeddingProvider } from '../src/ai/adapter';

function fakeEmbeddingModel(values: number[]): EmbeddingModel {
  return {
    specificationVersion: 'v4',
    provider: 'test.embedding',
    modelId: 'test-embedding',
    maxEmbeddingsPerCall: 1,
    supportsParallelCalls: false,
    doEmbed: async ({ values: inputs }: { values: string[] }) => ({
      embeddings: inputs.map(() => values),
      warnings: [],
    }),
  } as unknown as EmbeddingModel;
}

describe('LM Studio AI adapters', () => {
  it('converts AI SDK embeddings to the runtime Float32Array boundary', async () => {
    const provider = new AiSdkEmbeddingProvider({
      model: fakeEmbeddingModel([0.25, -0.5, 0.75]),
      dimensions: 3,
      requestTimeoutMs: 1000,
    });

    expect(Array.from(await provider.embed('hello Helm'))).toEqual([0.25, -0.5, 0.75]);
  });

  it('rejects an embedding response with the wrong configured dimension', async () => {
    const provider = new AiSdkEmbeddingProvider({
      model: fakeEmbeddingModel([0.25, -0.5]),
      dimensions: 3,
      requestTimeoutMs: 1000,
    });

    await expect(provider.embed('wrong size')).rejects.toThrow('expected 3');
  });

  it('targets the LM Studio OpenAI-compatible embeddings endpoint and model id', async () => {
    let requestUrl = '';
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestUrl = request.url;
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
      },
    });

    const result = await embed({
      model: provider.embeddingModel('text-embedding-nomic-embed-text-v1.5'),
      value: 'hello Helm',
      maxRetries: 0,
    });

    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(requestUrl).toBe('http://localhost:1234/v1/embeddings');
    expect(requestBody).toMatchObject({
      model: 'text-embedding-nomic-embed-text-v1.5',
      input: ['hello Helm'],
    });
  });
});
