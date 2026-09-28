import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { TaskDefinition, VerificationResult } from '@helm/shared';
import { ActingAgentExecutionError, AiSdkActingAgent } from '../../src/ai/acting-agent';
import type { ToolDefinition } from '../../src/tools/registry';

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

type CapturedRequest = { body: Record<string, unknown>; reply: ChatReply };

function textReply(id: string, content: string): ChatReply {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'acting-agent-test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function emptyReply(id: string): ChatReply {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'acting-agent-test-model',
    choices: [{ index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
  };
}

function toolReply(id: string, name: string, args: unknown): ChatReply {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'acting-agent-test-model',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: `call-${id}`,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function responseQueue(replies: ChatReply[], requests: CapturedRequest[]) {
  return createOpenAICompatible({
    name: 'acting-agent-tool-loop-test',
    baseURL: 'http://localhost:1234/v1',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      const reply = replies.shift();
      if (!reply) throw new Error('No scripted model response remains.');
      requests.push({ body, reply });
      return Response.json(reply);
    },
  });
}

function requestedTools(request: CapturedRequest): string[] {
  const tools = request.body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const fn = (value as Record<string, unknown>).function;
    if (!fn || typeof fn !== 'object') return [];
    const name = (fn as Record<string, unknown>).name;
    return typeof name === 'string' ? [name] : [];
  });
}

describe('acting agent native tool loop', () => {
  it('offers the full tool set and recovers from a real open-before-write error', async () => {
    const requests: CapturedRequest[] = [];
    const provider = responseQueue([
      toolReply('open-first', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
      toolReply('write', 'fs.write', { path: 'forex.txt', content: 'USD 133.20' }),
      toolReply('open-again', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
      textReply('done', 'I wrote forex.txt and opened it in the text editor.'),
    ], requests);
    const definitions: ToolDefinition[] = [
      { name: 'browser.navigate', description: 'Navigate to a URL.', inputSchema: z.object({ url: z.string() }), execute: async () => ({ ok: true }) },
      { name: 'browser.webSearch', description: 'Search the web.', inputSchema: z.object({ query: z.string() }), execute: async () => ({ ok: true }) },
      { name: 'browser.read', description: 'Read semantic page content.', inputSchema: z.object({ query: z.string().optional() }), execute: async () => ({ ok: true }) },
      { name: 'browser.query', description: 'Query the current DOM.', inputSchema: z.object({ selector: z.string().optional(), text: z.string().optional() }), execute: async () => ({ ok: true }) },
      { name: 'browser.evaluate', description: 'Evaluate in page context.', inputSchema: z.object({ expression: z.string() }), execute: async () => ({ ok: true }) },
      { name: 'fs.write', description: 'Write content to a sandbox file.', inputSchema: z.object({ path: z.string(), content: z.string() }), execute: async () => ({ ok: true }) },
      { name: 'app.openFile', description: 'Open an existing file; returns FILE_NOT_FOUND when missing.', inputSchema: z.object({ path: z.string(), application: z.string() }), execute: async () => ({ ok: true }) },
    ];
    let written = false;
    let opened = false;
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-tool-loop-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    const result = await agent.execute({
      userMessage: 'Write the exchange data to forex.txt and open it in the text editor.',
      task: {
        id: 'open-before-write',
        threadId: 'open-before-write',
        goal: 'Write the exchange data to forex.txt and open it in the text editor.',
        originalRequest: 'Write the exchange data to forex.txt and open it in the text editor.',
        criteria: [],
        requirements: [],
      } satisfies TaskDefinition,
      conversation: [],
      memories: [],
      toolDefinitions: definitions,
      executeTool: async (name, input) => {
        if (name === 'app.openFile' && !written) {
          return { ok: false, error: { code: 'FILE_NOT_FOUND', message: 'File does not exist: forex.txt' } };
        }
        if (name === 'fs.write') {
          written = true;
          return { ok: true, data: { path: input.path } };
        }
        if (name === 'app.openFile') {
          opened = true;
          return { ok: true, data: { path: input.path, application: input.application } };
        }
        return { ok: true };
      },
      verifyCompletion: async () => {
        const verification: VerificationResult = {
          complete: written && opened,
          criteria: [],
          requirements: [],
          summary: written && opened ? 'The requested file was written and opened.' : 'The requested effects are pending.',
        };
        return { ok: verification.complete, data: verification };
      },
      getRequirementSummary: () => `${written ? '[satisfied]' : '[pending]'} write; ${opened ? '[satisfied]' : '[pending]'} open`,
      maxToolActions: 8,
      maxModelTurns: 5,
      maxCompletionRecoveryTurns: 0,
      maxRepeatedAction: 2,
    });

    expect(result.response).toBe('I wrote forex.txt and opened it in the text editor.');
    expect(result.verification.complete).toBe(true);
    expect(written).toBe(true);
    expect(opened).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests.map(request => request.body.tool_choice)).toEqual(['auto', 'auto', 'auto', undefined]);
    const fullToolSet = requestedTools(requests[0]!);
    expect(fullToolSet).toEqual(expect.arrayContaining([
      'browser.navigate', 'browser.webSearch', 'browser.read', 'browser.query', 'browser.evaluate', 'fs.write', 'app.openFile',
    ]));
    expect(requests.slice(1, 3).every(request => requestedTools(request).sort().join('|') === [...fullToolSet].sort().join('|'))).toBe(true);
    expect(requestedTools(requests[3]!)).toEqual([]);
    expect(JSON.stringify(requests[1]!.body.messages)).toContain('FILE_NOT_FOUND');
    expect(result.diagnostics.modelTurns).toBe(3);
    expect(result.diagnostics.finalizationTurns).toBe(1);
    expect(result.diagnostics.modelRequestOutcomes?.map(outcome => outcome.outcome)).toEqual([
      'tool-call', 'tool-call', 'tool-call', 'final-response',
    ]);
    expect(result.diagnostics.modelRequestOutcomes?.map(outcome => outcome.providerCalls)).toEqual([1, 1, 1, 1]);
    expect(result.diagnostics.modelRequestOutcomes?.at(-1)?.completion).toBe('accepted');
    expect(result.diagnostics.modelRequestOutcomes?.[0]?.toolCalls).toEqual([
      { tool: 'app.openFile', outcome: 'failed', errorCode: 'FILE_NOT_FOUND' },
    ]);
  });

  it('records schema rejection separately while continuing the same useful tool conversation', async () => {
    const requests: CapturedRequest[] = [];
    const provider = responseQueue([
      toolReply('invalid-open-input', 'app.openFile', { path: 'notes.txt', content: 'x'.repeat(20_000) }),
      toolReply('write-notes', 'fs.write', { path: 'notes.txt', content: 'Notes from the page.' }),
      textReply('done', 'I wrote the notes to notes.txt.'),
    ], requests);
    let written = false;
    let toolActions = 0;
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-schema-diagnostic-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    const result = await agent.execute({
      userMessage: 'Write notes.txt.',
      task: { id: 'schema-diagnostic', threadId: 'schema-diagnostic', goal: 'Write notes.txt.', criteria: [], requirements: [] },
      conversation: [],
      memories: [],
      toolDefinitions: [
        { name: 'app.openFile', description: 'Open an existing file.', inputSchema: z.object({ path: z.string(), application: z.string() }).strict(), execute: async () => ({ ok: true }) },
        { name: 'fs.write', description: 'Write UTF-8 file content.', inputSchema: z.object({ path: z.string(), content: z.string() }), execute: async () => { written = true; return { ok: true }; } },
      ],
      executeTool: async name => {
        toolActions += 1;
        if (name === 'fs.write') {
          written = true;
          return { ok: true };
        }
        return { ok: false, error: { code: 'UNEXPECTED_EXECUTION', message: 'Invalid tool input should not execute.' } };
      },
      getToolActionCount: () => toolActions,
      verifyCompletion: async () => ({
        ok: written,
        data: { complete: written, criteria: [], requirements: [], summary: written ? 'Written.' : 'Pending.' },
      }),
      getRequirementSummary: () => written ? '[satisfied] notes.txt' : '[pending] notes.txt',
      maxToolActions: 4,
      maxModelTurns: 5,
      maxCompletionRecoveryTurns: 0,
      maxRepeatedAction: 2,
    });

    expect(result.response).toBe('I wrote the notes to notes.txt.');
    expect(result.diagnostics.modelTurns).toBe(2);
    expect(result.diagnostics.toolActions).toBe(1);
    expect(result.diagnostics.finalizationTurns).toBe(1);
    const invalidToolCall = result.diagnostics.modelRequestOutcomes?.[0]?.toolCalls?.[0];
    expect(invalidToolCall).toMatchObject({
      tool: 'app.openFile',
      outcome: 'schema-validation-failed',
      errorCode: 'INVALID_INPUT',
      input: { path: 'notes.txt' },
    });
    expect(invalidToolCall?.validationIssues?.some(issue => issue.path.join('.') === 'application')).toBe(true);
    const invalidInput = invalidToolCall?.input;
    expect(typeof invalidInput === 'object' && invalidInput !== null && !Array.isArray(invalidInput)
      ? String(invalidInput.content).length
      : 10_000).toBeLessThan(300);
    expect(requests).toHaveLength(3);
  });

  it('uses already-produced assistant text once the final tool makes verification complete', async () => {
    const requests: CapturedRequest[] = [];
    const provider = responseQueue([
      textReply('early-answer', 'I wrote notes.txt.'),
      toolReply('final-write', 'fs.write', { path: 'notes.txt', content: 'Today\'s notes.' }),
    ], requests);
    let written = false;
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-reuse-final-text-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    const result = await agent.execute({
      userMessage: 'Write notes.txt.',
      task: { id: 'reuse-final-text', threadId: 'reuse-final-text', goal: 'Write notes.txt.', criteria: [], requirements: [] },
      conversation: [],
      memories: [],
      toolDefinitions: [{
        name: 'fs.write',
        description: 'Write UTF-8 text to a file.',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async () => { written = true; return { ok: true }; },
      }],
      executeTool: async () => { written = true; return { ok: true }; },
      verifyCompletion: async ({ response }) => {
        const complete = written && response.includes('notes.txt');
        return { ok: complete, data: { complete, criteria: [], requirements: [], summary: complete ? 'Written.' : 'Pending.' } };
      },
      getRequirementSummary: () => written ? '[satisfied] notes.txt' : '[pending] notes.txt',
      maxToolActions: 2,
      maxModelTurns: 2,
      maxCompletionRecoveryTurns: 1,
      maxRepeatedAction: 2,
    });

    expect(result.response).toBe('I wrote notes.txt.');
    expect(result.verification.complete).toBe(true);
    expect(result.diagnostics.modelTurns).toBe(2);
    expect(result.diagnostics.finalizationTurns).toBe(0);
    expect(result.diagnostics.completionAttempts).toBe(2);
    expect(result.diagnostics.modelRequestOutcomes?.at(-1)?.completion).toBe('accepted');
    expect(requests).toHaveLength(2);
  });

  it('records an unknown tool call rejected before execution', async () => {
    const requests: CapturedRequest[] = [];
    const provider = responseQueue([toolReply('unknown-tool', 'browser.notRegistered', {})], requests);
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-unknown-tool-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    let diagnostics: Record<string, unknown> | undefined;
    let executed = false;
    try {
      await agent.execute({
        userMessage: 'Inspect the page.',
        task: { id: 'unknown-tool', threadId: 'unknown-tool', goal: 'Inspect the page.', criteria: [], requirements: [] },
        conversation: [],
        memories: [],
        toolDefinitions: [{
          name: 'fs.write', description: 'Write a file.', inputSchema: z.object({ path: z.string(), content: z.string() }),
          execute: async () => ({ ok: true }),
        }],
        executeTool: async () => { executed = true; return { ok: true }; },
        verifyCompletion: async () => ({ ok: true, data: { complete: true, criteria: [], requirements: [], summary: 'Complete.' } }),
        getRequirementSummary: () => '[pending] inspect the current page',
        onDiagnostics: value => { diagnostics = value as unknown as Record<string, unknown>; },
        maxToolActions: 4,
        maxModelTurns: 2,
        maxCompletionRecoveryTurns: 0,
        maxRepeatedAction: 2,
      });
    } catch {
      // The unknown tool is an actual model output error; inspect the recorded per-request diagnostic.
    }

    expect(executed).toBe(false);
    const outcomes = diagnostics?.modelRequestOutcomes as Array<Record<string, unknown>> | undefined;
    expect(outcomes?.[0]).toMatchObject({
      request: 1,
      outcome: 'tool-call',
      toolCalls: [{ tool: 'browser.notRegistered', outcome: 'rejected-before-execution', errorCode: 'UNKNOWN_TOOL' }],
    });
    expect(outcomes?.[1]).toMatchObject({ request: 2, outcome: 'provider-error', errorName: 'Error' });
    expect(requests).toHaveLength(1);
  });

  it('stops after one empty provider response instead of silently spending the remaining turn budget', async () => {
    const requests: CapturedRequest[] = [];
    const provider = responseQueue([emptyReply('empty')], requests);
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-empty-output-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    let caught: unknown;
    try {
      await agent.execute({
        userMessage: 'Write notes.txt.',
        task: { id: 'empty-output', threadId: 'empty-output', goal: 'Write notes.txt.', criteria: [], requirements: [] },
        conversation: [],
        memories: [],
        toolDefinitions: [],
        executeTool: async () => ({ ok: true }),
        verifyCompletion: async () => ({ ok: true, data: { complete: true, criteria: [], requirements: [], summary: 'Complete.' } }),
        getRequirementSummary: () => '[pending] notes.txt',
        maxToolActions: 4,
        maxModelTurns: 10,
        maxCompletionRecoveryTurns: 0,
        maxRepeatedAction: 2,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ActingAgentExecutionError);
    expect((caught as ActingAgentExecutionError).code).toBe('NO_ACTIONABLE_OUTPUT');
    expect((caught as ActingAgentExecutionError).details.modelRequestOutcomes).toMatchObject([
      { request: 1, outcome: 'no-actionable-output', providerCalls: 1, providerRetries: 0 },
    ]);
    expect(requests).toHaveLength(1);
  });

  it('stops when the model repeats the same unverified completion after identical feedback', async () => {
    const requests: CapturedRequest[] = [];
    const repeatedAnswer = 'I wrote notes.txt.';
    const provider = responseQueue([
      textReply('first-answer', repeatedAnswer),
      textReply('same-answer-again', repeatedAnswer),
    ], requests);
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-repeated-completion-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });
    let caught: unknown;
    try {
      await agent.execute({
        userMessage: 'Write notes.txt.',
        task: { id: 'repeated-completion', threadId: 'repeated-completion', goal: 'Write notes.txt.', criteria: [], requirements: [] },
        conversation: [],
        memories: [],
        toolDefinitions: [],
        executeTool: async () => ({ ok: true }),
        verifyCompletion: async () => ({
          ok: false,
          error: { code: 'UNSATISFIED_TASK_REQUIREMENTS', message: 'Missing requested effects:\n- notes.txt has not been written.' },
        }),
        getRequirementSummary: () => '[pending] notes.txt',
        maxToolActions: 4,
        maxModelTurns: 10,
        maxCompletionRecoveryTurns: 3,
        maxRepeatedAction: 2,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ActingAgentExecutionError);
    expect((caught as ActingAgentExecutionError).code).toBe('REPEATED_UNVERIFIED_COMPLETION');
    expect((caught as ActingAgentExecutionError).details.modelTurns).toBe(2);
    expect((caught as ActingAgentExecutionError).details.completionAttempts).toBe(2);
    expect((caught as ActingAgentExecutionError).details.completionRejections).toBe(2);
    expect(requests).toHaveLength(2);
  });

  it('keeps ordinary conversation on the same auto-choice path without calling tools', async () => {
    const requests: CapturedRequest[] = [];
    const provider = responseQueue([textReply('hello', 'Hello!')], requests);
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-conversation-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });

    const result = await agent.execute({
      userMessage: 'Hello',
      task: { id: 'chat', threadId: 'chat', goal: 'Hello', criteria: [], requirements: [], isConversation: true },
      conversation: [],
      memories: [],
      toolDefinitions: [],
      executeTool: async () => ({ ok: false, error: { code: 'UNEXPECTED_TOOL', message: 'No tool should run.' } }),
      verifyCompletion: async () => ({ ok: true, data: { complete: true, criteria: [], requirements: [], summary: 'Conversation complete.' } }),
      getRequirementSummary: () => '',
      maxToolActions: 2,
      maxModelTurns: 2,
      maxCompletionRecoveryTurns: 1,
      maxRepeatedAction: 2,
    });

    expect(result.response).toBe('Hello!');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).not.toBe('required');
    expect(requestedTools(requests[0]!)).toEqual([]);
  });
});
