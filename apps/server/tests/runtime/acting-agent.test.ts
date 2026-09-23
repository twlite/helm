import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';

import { AgentRuntime } from '../../src/agent/runtime';
import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';

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

type CapturedRequest = {
  body: Record<string, unknown>;
  reply: ChatReply;
};

function textReply(id: string, content: string): ChatReply {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'google/gemma-4-e2b',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function toolReply(id: string, name: string, args: unknown): ChatReply {
  return {
    id,
    object: 'chat.completion',
    created: 1,
    model: 'google/gemma-4-e2b',
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

function createRuntime(
  guest: MockGuestTransport,
  replies: ChatReply[],
  requests: CapturedRequest[],
  maxSteps = 12,
) {
  const provider = createOpenAICompatible({
    name: 'lmstudio',
    baseURL: 'http://localhost:1234/v1',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      const reply = replies.shift();
      if (!reply) throw new Error('The test model has no scripted reply remaining.');
      requests.push({ body, reply });
      return Response.json(reply);
    },
  });
  const tools = createGuestToolRegistry(guest);
  const actingAgent = new AiSdkActingAgent({
    model: provider.chatModel('google/gemma-4-e2b'),
    maxOutputTokens: 4_000,
    temperature: 0,
    requestTimeoutMs: 1_000,
  });
  return {
    tools,
    runtime: new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(guest),
      actingAgent,
      budgets: { maxSteps, maxRepeatedAction: 2, maxConsecutiveFailures: 3, toolTimeoutMs: 1_000 },
    }),
  };
}

function requestTools(request: CapturedRequest): string[] {
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

describe('native acting agent', () => {
  it('answers a conversational poem request without invoking computer tools', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const poem = 'A quiet cursor crosses the night,\nAnd turns a thought to gathered light.';
    const { runtime, tools } = createRuntime(guest, [
      toolReply('poem-complete', 'helm.complete', { response: poem, requiredEffects: [] }),
    ], requests);

    const result = await runtime.run({ threadId: 'poem-chat', userMessage: 'Write a beautiful poem about Helm.' });

    expect(result.status).toBe('completed');
    expect(result.assistantResponse).toBe(poem);
    expect(tools.invocations).toHaveLength(0);
    expect(guest.hasFile('/home/helm/workspace/poem.txt')).toBe(false);
    expect(requestTools(requests[0]!)).toContain('fs.write');
    expect(requestTools(requests[0]!)).toContain('browser.navigate');
    expect(JSON.stringify(requests[0]!.body.messages)).toContain('Write a beautiful poem about Helm.');
  });

  it('saves a prior assistant poem from conversation context through fs.write', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const poem = 'Helm follows each new thought,\nAnd makes the distant task complete.';
    const { runtime, tools } = createRuntime(guest, [
      toolReply('poem-write', 'fs.write', { path: 'poem.txt', content: poem }),
      toolReply('poem-saved', 'helm.complete', {
        response: 'Saved the poem in poem.txt.',
        requiredEffects: [{ tool: 'fs.write' }],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'poem-follow-up',
      userMessage: 'Save it in a text file.',
      conversation: [
        { id: 'u1', threadId: 'poem-follow-up', role: 'user', content: 'Write a beautiful poem about Helm.', metadata: {}, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'a1', threadId: 'poem-follow-up', role: 'assistant', content: poem, metadata: {}, createdAt: '2026-01-01T00:00:01.000Z' },
        { id: 'u2', threadId: 'poem-follow-up', role: 'user', content: 'Save it in a text file.', metadata: {}, createdAt: '2026-01-01T00:00:02.000Z' },
      ],
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/poem.txt')).toBe(poem);
    expect(result.assistantResponse).toBe('Saved the poem in poem.txt.');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['fs.write']);
    const nextMessages = JSON.stringify(requests[1]!.body.messages);
    expect(nextMessages).toContain('Helm follows each new thought,');
    expect(nextMessages).toContain('tool');
  });

  it('handles an unspecified "poem txt file" name without a phrase parser', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const content = 'A local agent, steady and clear,\nTurns small intentions into work here.';
    const { runtime } = createRuntime(guest, [
      toolReply('poem-txt-write', 'fs.write', { path: 'poem.txt', content }),
      toolReply('poem-txt-complete', 'helm.complete', {
        response: 'I saved the poem in poem.txt.',
        requiredEffects: [{ tool: 'fs.write' }],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'poem-txt',
      userMessage: 'Write a beautiful poem about Helm in a poem txt file.',
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/poem.txt')).toBe(content);
    expect(requestTools(requests[0]!)).toContain('fs.write');
  });

  it('writes meaningful model-generated poem contents directly to poem.txt', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const content = 'A steady helm through open skies,\nWhere every useful answer lies.';
    const { runtime } = createRuntime(guest, [
      toolReply('explicit-poem-write', 'fs.write', { path: 'poem.txt', content }),
      toolReply('explicit-poem-complete', 'helm.complete', {
        response: 'I wrote the poem to poem.txt.',
        requiredEffects: [{ tool: 'fs.write' }],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'explicit-poem-file',
      userMessage: 'Write a beautiful poem about Helm in a poem.txt file.',
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/poem.txt')).toBe(content);
    expect(result.steps.some(step => step.toolName === 'fs.write' && step.toolResult?.ok)).toBe(true);
  });

  it('returns a failed tool result to the model so it can recover', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const content = 'A useful tool learns from what went wrong.';
    const { runtime } = createRuntime(guest, [
      toolReply('bad-write', 'fs.write', { path: '/tmp/outside.txt', content }),
      toolReply('recovered-write', 'fs.write', { path: 'recovered.txt', content }),
      toolReply('recovered-complete', 'helm.complete', {
        response: 'I recovered from the first write error and saved recovered.txt.',
        requiredEffects: [{ tool: 'fs.write' }],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'tool-recovery',
      userMessage: 'Write a short line to a text file.',
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/recovered.txt')).toBe(content);
    expect(JSON.stringify(requests[1]!.body.messages)).toContain('PATH_OUTSIDE_ALLOWED_ROOT');
  });

  it('answers a browser research question from the page content it inspected', async () => {
    const followerCount = String(700 + Math.floor(Math.random() * 8_000));
    const profileUrl = 'https://github.com/twlite';
    const guest = new MockGuestTransport({
      pages: { [profileUrl]: `<html><body><h1>Twilight</h1><p>${followerCount} followers</p></body></html>` },
    });
    const requests: CapturedRequest[] = [];
    const response = `The profile currently shows ${followerCount} followers.`;
    const { runtime, tools } = createRuntime(guest, [
      toolReply('followers-nav', 'browser.navigate', { url: profileUrl }),
      toolReply('followers-text', 'browser.extractText', {}),
      toolReply('followers-complete', 'helm.complete', {
        response,
        requiredEffects: [{ tool: 'browser.navigate' }, { tool: 'browser.extractText' }],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'github-followers',
      userMessage: 'go to github.com/twlite and find out how many followers he has',
    });

    expect(result.status).toBe('completed');
    expect(result.assistantResponse).toBe(response);
    expect(result.assistantResponse).toContain(followerCount);
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual([
      'browser.navigate', 'browser.extractText',
    ]);
    expect(JSON.stringify(requests[2]!.body.messages)).toContain(followerCount);
  });

  it('rejects a completion claim without a successful file effect and returns the rejection to the model', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      textReply('draft-1', 'I saved the poem in poem.txt.'),
      toolReply('check-1', 'helm.complete', {
        response: 'I saved the poem in poem.txt.',
        requiredEffects: [{ tool: 'fs.write' }],
      }),
      textReply('draft-2', 'The file is not saved yet.'),
      toolReply('check-2', 'helm.complete', {
        response: 'The file is not saved yet.',
        requiredEffects: [{ tool: 'fs.write' }],
      }),
      textReply('draft-3', 'The file is still unavailable.'),
    ], requests, 1);

    const result = await runtime.run({
      threadId: 'completion-guard',
      userMessage: 'Write a poem and save it in poem.txt.',
    });

    expect(result.status).toBe('failed');
    expect(guest.hasFile('/home/helm/workspace/poem.txt')).toBe(false);
    expect(tools.invocations).toHaveLength(0);
    expect(JSON.stringify(requests[2]!.body.messages)).toContain('UNVERIFIED_SIDE_EFFECT');
  });

  it('bounds repeated identical tool calls that make no state change', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('exists-1', 'fs.exists', { path: 'missing.txt' }),
      toolReply('exists-2', 'fs.exists', { path: 'missing.txt' }),
      toolReply('exists-3', 'fs.exists', { path: 'missing.txt' }),
      toolReply('exists-complete', 'helm.complete', {
        response: 'The file does not exist.',
        requiredEffects: [],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'repeated-tool-call',
      userMessage: 'Check whether missing.txt exists.',
    });

    expect(result.status).toBe('completed');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['fs.exists', 'fs.exists']);
    expect(JSON.stringify(requests[3]!.body.messages)).toContain('REPEATED_ACTION');
  });

  it('returns browser evidence to the acting model before it generates and writes a portfolio', async () => {
    const followerCount = String(700 + Math.floor(Math.random() * 8_000));
    const repositoryName = `repo-${crypto.randomUUID().slice(0, 8)}`;
    const profileUrl = 'https://github.com/twlite';
    const profileImageUrl = 'https://github.com/twlite.png';
    const page = `<html><body><h1>Twilight</h1><p>Followers: ${followerCount}</p><h2>Pinned</h2><p>${repositoryName}: observed repository detail</p></body></html>`;
    const portfolio = `<!doctype html><html><head><style>body{font-family:system-ui;background:#111;color:#f5f5f5}</style></head><body><main><img src="${profileImageUrl}" alt="Twilight"><h1>Twilight</h1><p>Followers: ${followerCount}</p><article>${repositoryName}: observed repository detail</article></main></body></html>`;
    const guest = new MockGuestTransport({ pages: { [profileUrl]: page } });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('profile-nav', 'browser.navigate', { url: profileUrl }),
      toolReply('profile-text', 'browser.extractText', {}),
      toolReply('portfolio-write', 'fs.write', { path: 'twlite.html', content: portfolio }),
      toolReply('portfolio-complete', 'helm.complete', {
        response: 'Created twlite.html using the observed profile information.',
        requiredEffects: [
          { tool: 'browser.navigate' },
          { tool: 'browser.extractText' },
          { tool: 'fs.write' },
        ],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'github-portfolio',
      userMessage: `go to github.com/twlite and find out how many followers he has and his pinned repos with their details. Using that information, create twlite.html with a good looking portfolio website for Twilight. Use this as the profile picture image url: ${profileImageUrl}`,
    });

    expect(result.status).toBe('completed');
    const html = guest.getFile('/home/helm/workspace/twlite.html') ?? '';
    expect(html.toLowerCase()).toContain('<!doctype html>');
    expect(html).toContain('<style>');
    expect(html).toContain(`<img src="${profileImageUrl}"`);
    expect(html).toContain(followerCount);
    expect(html).toContain(repositoryName);
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual([
      'browser.navigate', 'browser.extractText', 'fs.write',
    ]);
    expect(requests[2]!.body.tools).toBeDefined();
    expect(JSON.stringify(requests[2]!.body.messages)).toContain(followerCount);
    expect(JSON.stringify(requests[2]!.body.messages)).toContain(repositoryName);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.navigate'))
      .toHaveLength(1);
    expect((tools.invocations.find(invocation => invocation.tool === 'browser.navigate')?.input as { url: string }).url)
      .toBe(profileUrl);
  });
});
