import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';

import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import type { Message, VerificationResult } from '@helm/shared';

type ChatReply = {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: Record<string, unknown>;
    finish_reason: 'stop' | 'tool_calls';
  }>;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

function reply(id: string, message: Record<string, unknown>, finishReason: 'stop' | 'tool_calls'): ChatReply {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'context-test-model',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

describe('acting agent context integration', () => {
  it('reports the path when prepared conversation messages do not match the SDK schema', async () => {
    let requestCount = 0;
    const provider = createOpenAICompatible({
      name: 'context-validation-test',
      baseURL: 'http://localhost:1234/v1',
      fetch: async () => {
        requestCount += 1;
        return Response.json(reply('unexpected', { role: 'assistant', content: 'unexpected' }, 'stop'));
      },
    });
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('context-validation-test'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    const currentRequest = 'Continue the earlier task.';
    const conversation: Message[] = [
      {
        id: 'old-user',
        threadId: 'invalid-context-thread',
        role: 'user',
        content: 'Earlier request.',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'old-assistant',
        threadId: 'invalid-context-thread',
        role: 'assistant',
        content: [{ type: 'text' }] as unknown as string,
        metadata: {},
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ];
    const verification: VerificationResult = {
      complete: true,
      criteria: [],
      requirements: [],
      summary: 'No external effect was requested.',
    };

    let caught: unknown;
    try {
      await agent.execute({
        userMessage: currentRequest,
        conversation,
        memories: [],
        toolDefinitions: [],
        executeTool: async () => ({ ok: false, error: { code: 'UNEXPECTED_TOOL', message: 'No tool was expected.' } }),
        verifyCompletion: async () => ({ ok: true, data: verification }),
        maxSteps: 2,
        maxRepeatedAction: 2,
        maxConsecutiveFailures: 2,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('Prepared acting-agent context failed ModelMessage[] validation');
    expect((caught as Error).message).toContain('[1]');
    expect(requestCount).toBe(0);
  });

  it('runs structured compaction only at pressure and reports usage and the persisted event', async () => {
    const replies = [
      reply('summary', {
        role: 'assistant',
        content: JSON.stringify({
          conversationIntent: ['Continue the earlier request.'],
          completed: [],
          findings: [],
          unresolved: ['Finish the requested task.'],
          failedApproaches: [],
        }),
      }, 'stop'),
      reply('complete', {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call-complete',
          type: 'function',
          function: {
            name: 'helm.complete',
            arguments: JSON.stringify({ response: 'The conversation is complete.', requiredEffects: [] }),
          },
        }],
      }, 'tool_calls'),
    ];
    const requests: Record<string, unknown>[] = [];
    const provider = createOpenAICompatible({
      name: 'context-test',
      baseURL: 'http://localhost:1234/v1',
      supportsStructuredOutputs: true,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(JSON.parse(await request.text()) as Record<string, unknown>);
        const next = replies.shift();
        if (!next) throw new Error('No scripted model response remains.');
        return Response.json(next);
      },
    });
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('context-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
      contextBudget: {
        contextWindowTokens: 1_000,
        contextCompactAtRatio: 0.3,
        contextCriticalAtRatio: 0.8,
        contextRecentExchanges: 1,
        contextCriticalRecentExchanges: 1,
      },
    });
    const currentRequest = 'Continue the earlier request.';
    const conversation: Message[] = [
      {
        id: 'old-user',
        threadId: 'context-thread',
        role: 'user',
        content: 'Please preserve this request context.',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'old-assistant',
        threadId: 'context-thread',
        role: 'assistant',
        content: 'Earlier operational detail. '.repeat(1_000),
        metadata: {},
        createdAt: '2026-01-01T00:00:01.000Z',
      },
    ];
    const usageEvents: unknown[] = [];
    const compactionEvents: Array<Record<string, unknown>> = [];
    const verification: VerificationResult = {
      complete: true,
      criteria: [],
      requirements: [],
      summary: 'No external effect was requested.',
    };

    const result = await agent.execute({
      userMessage: currentRequest,
      conversation,
      memories: [],
      toolDefinitions: [],
      executeTool: async () => ({ ok: false, error: { code: 'UNEXPECTED_TOOL', message: 'No tool was expected.' } }),
      verifyCompletion: async () => ({ ok: true, data: verification }),
      onContextUsage: event => usageEvents.push(event),
      onContextCompacted: event => compactionEvents.push(event as unknown as Record<string, unknown>),
      maxSteps: 2,
      maxRepeatedAction: 2,
      maxConsecutiveFailures: 2,
    });

    expect(result.response).toBe('The conversation is complete.');
    expect(requests).toHaveLength(2);
    expect(usageEvents).toHaveLength(1);
    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0]).toMatchObject({
      reason: expect.stringContaining('context-pressure threshold'),
      summary: { goal: currentRequest },
    });
  });
});
