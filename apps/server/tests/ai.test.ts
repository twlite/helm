import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { embed, type EmbeddingModel } from 'ai';
import { describe, expect, it } from 'bun:test';

import { AiSdkEmbeddingProvider, AiSdkThreadTitleGenerator } from '../src/ai/adapter';

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

  it('generates a thread title through the configured language model', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-title',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ title: 'Research twlite.dev' }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });

    const generator = new AiSdkThreadTitleGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });

    await expect(generator.generate('  Research twlite.dev and save the page  ')).resolves.toBe('Research twlite.dev');
    expect(requestBody).toMatchObject({
      model: 'google/gemma-4-e2b',
      response_format: { type: 'json_schema' },
    });
  });

  it('falls back to the trimmed input when title generation fails', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async () => {
        throw new Error('LM Studio is unavailable');
      },
    });
    const generator = new AiSdkThreadTitleGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });

    await expect(generator.generate('  Save this page to a file  ')).resolves.toBe('Save this page to a file');
  });
});
