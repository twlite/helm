import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractContextWindowTokens,
  resolveModelContextWindow,
  toSummaryTriggerTokens,
} from './model-context.ts';

describe('model context metadata', () => {
  it('extracts common provider context window fields', () => {
    assert.equal(
      extractContextWindowTokens({ context_length: 131072 }),
      131072,
    );
    assert.equal(
      extractContextWindowTokens({
        metadata: { max_context_length: '32768' },
      }),
      32768,
    );
    assert.equal(
      extractContextWindowTokens({
        model_info: { max_position_embeddings: 8192 },
      }),
      8192,
    );
  });

  it('resolves model metadata from an OpenAI-compatible models response', async () => {
    const fetchCalls: string[] = [];
    const result = await resolveModelContextWindow({
      baseUrl: 'http://localhost:1234/v1/',
      fetchFn: async (url) => {
        fetchCalls.push(String(url));
        return new Response(
          JSON.stringify({
            data: [
              { id: 'other-model', context_length: 4096 },
              { id: 'qwen-vl', max_context_length: 65536 },
            ],
          }),
          {
            headers: { 'content-type': 'application/json' },
            status: 200,
          },
        );
      },
      modelId: 'qwen-vl',
    });

    assert.deepEqual(fetchCalls, ['http://localhost:1234/v1/models']);
    assert.equal(result.contextWindowTokens, 65536);
    assert.equal(result.source, 'provider');
  });

  it('falls back when provider metadata is unavailable', async () => {
    const result = await resolveModelContextWindow({
      baseUrl: 'http://localhost:1234/v1',
      fetchFn: async () =>
        new Response(JSON.stringify({ data: [{ id: 'qwen-vl' }] }), {
          headers: { 'content-type': 'application/json' },
          status: 200,
        }),
      modelId: 'qwen-vl',
    });

    assert.equal(result.contextWindowTokens, null);
    assert.equal(result.source, 'fallback');
  });

  it('uses 80 percent of provider context as the effective trigger', () => {
    assert.equal(
      toSummaryTriggerTokens({
        fallbackTriggerTokens: 9000,
        ratio: 0.8,
        resolvedContextWindowTokens: 32768,
      }),
      26214,
    );

    assert.equal(
      toSummaryTriggerTokens({
        fallbackTriggerTokens: 9000,
        ratio: 0.8,
        resolvedContextWindowTokens: null,
      }),
      9000,
    );
  });
});
