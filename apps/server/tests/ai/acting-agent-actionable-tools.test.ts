import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import type { TaskDefinition, TaskRequirement, VerificationResult } from '@helm/shared';
import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import type { ToolDefinition } from '../../src/tools/tool-registry';

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

function requirement(id: string, action: string, dependsOn: string[] = []): TaskRequirement {
  return {
    id,
    description: `Complete ${id}`,
    type: action.startsWith('app.') ? 'desktop' : 'filesystem',
    mandatory: true,
    target: { action, freshness: 'current-run', mode: action === 'fs.write' ? 'written' : 'opened' },
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
  };
}

describe('acting agent actionable tool control', () => {
  it('recovers from premature text under required tool choice and exposes dependent tools only after their prerequisite succeeds', async () => {
    let written = false;
    let opened = false;
    let verificationCalls = 0;
    const requests: CapturedRequest[] = [];
    const replies = [
      // The provider also tries an action that is blocked by the dependency
      // graph. `activeTools` omits it, so it cannot reach the runtime.
      toolReply('early-open', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
      // Local model servers can ignore tool_choice=required. The SDK surfaces
      // this as ToolChoiceViolationError before agent.generate returns.
      textReply('premature-done', 'Done.'),
      toolReply('write', 'fs.write', { path: 'forex.txt', content: 'Observed data' }),
      toolReply('open', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
      textReply('final', 'The file was written and opened.'),
    ];
    const provider = createOpenAICompatible({
      name: 'acting-agent-actionable-test',
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
    const definitions: ToolDefinition[] = [
      {
        name: 'fs.write',
        description: 'Write a file.',
        inputSchema: z.object({ path: z.string(), content: z.string() }).strict(),
        execute: async () => ({ ok: true }),
      },
      {
        name: 'app.openFile',
        description: 'Open a file in an application.',
        inputSchema: z.object({ path: z.string(), application: z.string() }).strict(),
        execute: async () => ({ ok: true }),
      },
    ];
    const requirements = [
      requirement('outputFile', 'fs.write'),
      requirement('openFile', 'app.openFile', ['outputFile']),
    ];
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-actionable-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });

    const result = await agent.execute({
      userMessage: 'Write the observed data to forex.txt and open it in the text editor.',
      task: {
        id: 'actionable-tools',
        threadId: 'actionable-tools',
        goal: 'Write the observed data to forex.txt and open it in the text editor.',
        originalRequest: 'Write the observed data to forex.txt and open it in the text editor.',
        criteria: [],
        requirements,
      } satisfies TaskDefinition,
      conversation: [],
      memories: [],
      toolDefinitions: definitions,
      executeTool: async (name, input) => {
        if (name === 'fs.write') {
          expect(opened).toBe(false);
          written = true;
          return { ok: true, data: { path: input.path } };
        }
        if (name === 'app.openFile') {
          // This assertion exercises the ordering invariant at the tool boundary.
          expect(written).toBe(true);
          opened = true;
          return { ok: true, data: { path: input.path } };
        }
        return { ok: false, error: { code: 'UNEXPECTED_TOOL', message: name } };
      },
      verifyCompletion: async () => {
        verificationCalls += 1;
        const verification: VerificationResult = {
          complete: written && opened,
          criteria: [],
          requirements: [],
          summary: written && opened ? 'All required actions completed.' : 'Required actions remain.',
        };
        return { ok: verification.complete, data: verification };
      },
      reportBlocked: async () => ({ ok: false, error: { code: 'NO_FAILURE', message: 'No tool failure was recorded.' } }),
      getRequirementSummary: () => [
        `${written ? '[satisfied]' : '[pending]'} outputFile action=fs.write`,
        `${opened ? '[satisfied]' : written ? '[pending]' : '[blocked]'} openFile action=app.openFile dependsOn=outputFile`,
      ].join('\n'),
      getActionableTools: () => opened ? [] : written ? ['app.openFile'] : ['fs.write'],
      getToolActionCount: () => Number(written) + Number(opened),
      maxToolActions: 4,
      maxModelTurns: 5,
      // A premature text proposal must not consume completion recovery turns.
      maxCompletionRecoveryTurns: 0,
      maxRepeatedAction: 2,
      maxConsecutiveFailures: 2,
    });

    expect(result.response).toBe('The file was written and opened.');
    expect(result.verification.complete).toBe(true);
    expect(written).toBe(true);
    expect(opened).toBe(true);
    expect(verificationCalls).toBe(1);
    expect(requests).toHaveLength(5);
    expect(requests.slice(0, 4).map(request => request.body.tool_choice)).toEqual(['required', 'required', 'required', 'required']);
    expect(requestedTools(requests[0]!)).toEqual(['fs.write']);
    expect(requestedTools(requests[1]!)).toEqual(['fs.write']);
    expect(requestedTools(requests[2]!)).toEqual(['fs.write']);
    expect(requestedTools(requests[3]!)).toEqual(['app.openFile']);
    expect(requestedTools(requests[0]!)).not.toContain('app.openFile');
    expect(requestedTools(requests[1]!)).not.toContain('app.openFile');
    expect(requestedTools(requests[2]!)).not.toContain('app.openFile');
    expect(result.diagnostics).toMatchObject({
      modelTurns: 5,
      modelRequests: 5,
      toolActions: 2,
      completionAttempts: 1,
      completionRejections: 0,
    });
    expect(JSON.stringify(requests[2]!.body.messages)).toContain('Done.');
    expect(JSON.stringify(requests[2]!.body.messages)).toContain('Currently available task choices: fs.write');
  });

  it('keeps ordinary conversation free of required tool choice', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createOpenAICompatible({
      name: 'acting-agent-conversation-test',
      baseURL: 'http://localhost:1234/v1',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        const reply = textReply('hello', 'Hello!');
        requests.push({ body, reply });
        return Response.json(reply);
      },
    });
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
      reportBlocked: async () => ({ ok: false, error: { code: 'NO_FAILURE', message: 'No failure.' } }),
      getRequirementSummary: () => '',
      getActionableTools: () => [],
      maxToolActions: 2,
      maxModelTurns: 2,
      maxCompletionRecoveryTurns: 1,
      maxRepeatedAction: 2,
      maxConsecutiveFailures: 2,
    });

    expect(result.response).toBe('Hello!');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).not.toBe('required');
    expect(requestedTools(requests[0]!)).toEqual([]);
  });

  it('offers blocker reporting only for a requirement with verified failure evidence', async () => {
    const requests: CapturedRequest[] = [];
    const provider = createOpenAICompatible({
      name: 'acting-agent-blocker-test',
      baseURL: 'http://localhost:1234/v1',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const body = JSON.parse(await request.text()) as Record<string, unknown>;
        const reply = toolReply('verified-blocker', 'helm.blocked', {
          response: 'The required write action failed and cannot be recovered.',
          requirementIds: ['outputFile'],
        });
        requests.push({ body, reply });
        return Response.json(reply);
      },
    });
    const agent = new AiSdkActingAgent({
      model: provider.chatModel('acting-agent-blocker-test-model'),
      maxOutputTokens: 1_000,
      temperature: 0,
      requestTimeoutMs: 1_000,
    });

    const result = await agent.execute({
      userMessage: 'Write the requested data to forex.txt.',
      task: {
        id: 'verified-blocker',
        threadId: 'verified-blocker',
        goal: 'Write the requested data to forex.txt.',
        criteria: [],
        requirements: [requirement('outputFile', 'fs.write')],
      },
      conversation: [],
      memories: [],
      toolDefinitions: [],
      executeTool: async () => ({ ok: false, error: { code: 'UNEXPECTED_TOOL', message: 'No tool is available.' } }),
      verifyCompletion: async () => ({
        ok: true,
        data: { complete: false, criteria: [], requirements: [], summary: 'The output remains pending.' },
      }),
      reportBlocked: async () => ({ ok: true, data: { blocked: true } }),
      getRequirementSummary: () => '[pending] outputFile action=fs.write',
      getActionableTools: () => [],
      getBlockableRequirementIds: () => ['outputFile'],
      maxToolActions: 2,
      maxModelTurns: 2,
      maxCompletionRecoveryTurns: 0,
      maxRepeatedAction: 2,
      maxConsecutiveFailures: 2,
    });

    expect(result.blocked?.requirementIds).toEqual(['outputFile']);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body.tool_choice).toBe('required');
    expect(requestedTools(requests[0]!)).toEqual(['helm.blocked']);
  });
});
