import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { asSchema, embed, type EmbeddingModel } from 'ai';
import { describe, expect, it } from 'bun:test';
import type { AgentTurnContext } from '@helm/shared';

import type { AgentRuntimeResult } from '../src/agent/types';
import {
  AiSdkDecisionProvider,
  AiSdkEmbeddingProvider,
  AiSdkResponseGenerator,
  AiSdkTaskPlanner,
  AiSdkThreadTitleGenerator,
  aiTaskPlanSchema,
  aiDecisionSchema,
} from '../src/ai/adapter';
import { adaptStructuredOutputJsonSchema } from '../src/ai/structured-output';

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
  it('keeps arbitrary action input keys while adapting the MLX schema', async () => {
    const nativeSchema = await asSchema(aiDecisionSchema).jsonSchema;
    const compatibleSchema = adaptStructuredOutputJsonSchema(nativeSchema, 'lmstudio-mlx');
    const actionBranch = (compatibleSchema.oneOf as Array<Record<string, unknown>>).find(branch => (
      ((branch.properties as Record<string, unknown>).type as Record<string, unknown>).const === 'action'
    ));
    const actionInput = (actionBranch?.properties as Record<string, unknown>).input;

    expect(actionInput).toEqual({ type: 'object', additionalProperties: {} });
    expect(compatibleSchema.oneOf).toHaveLength(3);
    expect(actionBranch).toMatchObject({ additionalProperties: false });
    expect(JSON.stringify(compatibleSchema)).not.toContain('propertyNames');

    const parsed = aiDecisionSchema.safeParse({
      type: 'action',
      tool: 'some_tool',
      input: { foo: 'bar', nested: { anything: true } },
    });
    expect(parsed.success).toBe(true);
  });

  it('preserves the native schema object for providers without compatibility requirements', async () => {
    const nativeSchema = await asSchema(aiDecisionSchema).jsonSchema;

    expect(adaptStructuredOutputJsonSchema(nativeSchema, 'native')).toBe(nativeSchema);
    expect(JSON.stringify(nativeSchema)).toContain('propertyNames');
  });

  it('keeps all decision variants valid and rejects invalid top-level shapes', () => {
    expect(aiDecisionSchema.safeParse({ type: 'complete' }).success).toBe(true);
    expect(aiDecisionSchema.safeParse({ type: 'blocked', reason: 'Needs attention' }).success).toBe(true);
    expect(aiDecisionSchema.safeParse({ type: 'unexpected' }).success).toBe(false);
    expect(aiDecisionSchema.safeParse({ type: 'action', tool: 'some_tool' }).success).toBe(false);
  });

  it('sends the MLX-compatible schema to the model without weakening native validation', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-decision',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({
                type: 'action',
                tool: 'some_tool',
                input: { foo: 'bar', nested: { anything: true } },
              }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const decisionProvider = new AiSdkDecisionProvider({
      model: provider.chatModel('google/gemma-4-e2b'),
      toolDefinitions: [],
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });
    const context: AgentTurnContext = {
      task: {
        id: 'task-1',
        threadId: 'thread-1',
        goal: 'Do a thing',
        criteria: [{ type: 'file.exists', path: 'note.txt' }],
      },
      observation: {
        timestamp: 1,
        task: { completedCriteria: [], remainingCriteria: ['File exists: note.txt'] },
      },
      history: [],
      memories: [],
      stepIndex: 0,
      previousResults: [],
    };

    await expect(decisionProvider.next(context)).resolves.toMatchObject({
      type: 'action',
      tool: 'some_tool',
    });

    const responseFormat = requestBody?.response_format as Record<string, unknown>;
    const modelSchema = ((responseFormat?.json_schema as Record<string, unknown>)?.schema) as Record<string, unknown>;
    expect(JSON.stringify(modelSchema)).not.toContain('propertyNames');
    expect(modelSchema.oneOf).toHaveLength(3);
  });

  it('plans ordinary conversation without inventing a browser criterion', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-plan',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: {
              role: 'assistant',
              content: JSON.stringify({ mode: 'conversation', goal: 'Answer the user directly.', criteria: [] }),
            },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const planner = new AiSdkTaskPlanner({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
      structuredOutputCompatibility: 'lmstudio-mlx',
    });

    await expect(planner.createTask({
      threadId: 'thread-chat',
      userMessage: 'Please answer this question about Helm: who are you?',
      conversation: [{
        id: 'message-1',
        threadId: 'thread-chat',
        role: 'user',
        content: 'Who are you?',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    })).resolves.toMatchObject({ criteria: [], goal: 'Answer the user directly.' });

    expect(aiTaskPlanSchema.safeParse({ mode: 'conversation', goal: 'Answer directly.', criteria: [] }).success).toBe(true);
    expect(JSON.stringify(requestBody)).toContain('Who are you?');
  });

  it('short-circuits clear identity chat before task planning', async () => {
    const planner = new AiSdkTaskPlanner({
      model: {} as never,
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });

    await expect(planner.createTask({
      threadId: 'thread-chat',
      userMessage: 'Who are you?',
    })).resolves.toMatchObject({
      goal: 'Who are you?',
      criteria: [],
    });
  });

  it('generates a conversational final answer from the thread and tool evidence', async () => {
    let requestBody: Record<string, unknown> | undefined;
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requestBody = JSON.parse(await request.text()) as Record<string, unknown>;
        return Response.json({
          id: 'chatcmpl-response',
          object: 'chat.completion',
          created: 1,
          model: 'google/gemma-4-e2b',
          choices: [{
            index: 0,
            message: { role: 'assistant', content: 'I am Helm, your local desktop agent.' },
            finish_reason: 'stop',
          }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
      },
    });
    const generator = new AiSdkResponseGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });
    const result = {
      run: {
        id: 'run-chat',
        threadId: 'thread-chat',
        goal: 'Answer the user directly.',
        status: 'completed' as const,
        criteria: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      task: {
        id: 'task-chat',
        threadId: 'thread-chat',
        goal: 'Answer the user directly.',
        criteria: [],
      },
      history: [],
      steps: [],
      observations: [],
      finalVerification: { complete: true, criteria: [], summary: 'Response ready.' },
      status: 'completed' as const,
    } satisfies AgentRuntimeResult;

    await expect(generator.generate({
      userMessage: 'Who are you?',
      conversation: [{
        id: 'message-1',
        threadId: 'thread-chat',
        role: 'user',
        content: 'Who are you?',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      result,
    })).resolves.toBe('I am Helm, your local desktop agent.');
    expect(JSON.stringify(requestBody)).toContain('Who are you?');
  });

  it('streams conversational response deltas in order', async () => {
    const provider = createOpenAICompatible({
      name: 'lmstudio',
      baseURL: 'http://localhost:1234/v1',
      fetch: async () => {
        const chunks = [
          {
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'google/gemma-4-e2b',
            choices: [{ index: 0, delta: { role: 'assistant', content: 'I am ' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'google/gemma-4-e2b',
            choices: [{ index: 0, delta: { content: 'Helm.' }, finish_reason: null }],
          },
          {
            id: 'chatcmpl-stream',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'google/gemma-4-e2b',
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          },
        ];
        const body = `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}`).join('\n\n')}\n\ndata: [DONE]\n\n`;
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
      },
    });
    const generator = new AiSdkResponseGenerator({
      model: provider.chatModel('google/gemma-4-e2b'),
      maxOutputTokens: 128,
      temperature: 0,
      requestTimeoutMs: 1000,
    });
    const result = {
      run: {
        id: 'run-stream',
        threadId: 'thread-stream',
        goal: 'Answer the user directly.',
        status: 'completed' as const,
        criteria: [],
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      task: {
        id: 'task-stream',
        threadId: 'thread-stream',
        goal: 'Answer the user directly.',
        criteria: [],
      },
      history: [],
      steps: [],
      observations: [],
      finalVerification: { complete: true, criteria: [], summary: 'Response ready.' },
      status: 'completed' as const,
    } satisfies AgentRuntimeResult;
    const deltas: string[] = [];

    await expect(generator.stream({
      userMessage: 'Who are you?',
      conversation: [],
      result,
      onDelta: delta => deltas.push(delta),
    })).resolves.toBe('I am Helm.');
    expect(deltas).toEqual(['I am ', 'Helm.']);
  });

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
