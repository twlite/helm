import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';

import { AgentRuntime } from '../../src/agent/runtime';
import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import { MemoryService } from '../../src/memory/service';
import { registerMemoryTools } from '../../src/memory/tools';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import { testDatabase } from '../persistence/helpers';

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

type ScriptedReply = ChatReply | ((body: Record<string, unknown>) => ChatReply);

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
  replies: ScriptedReply[],
  requests: CapturedRequest[],
  maxSteps = 12,
) {
  const provider = createOpenAICompatible({
    name: 'lmstudio',
    baseURL: 'http://localhost:1234/v1',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      const nextReply = replies.shift();
      if (!nextReply) throw new Error('The test model has no scripted reply remaining.');
      const reply = typeof nextReply === 'function' ? nextReply(body) : nextReply;
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
  it('exposes separate bounded page reading and query search operations', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('catalog-complete', 'helm.complete', { response: 'Ready.', requiredEffects: [] }),
    ], requests);

    const result = await runtime.run({ threadId: 'browser-catalog', userMessage: 'Find useful information on a webpage.' });

    expect(result.status).toBe('completed');
    const definitions = requests[0]!.body.tools as Array<{ function?: { name?: string; parameters?: Record<string, unknown> } }>;
    const readDefinition = definitions.find(definition => definition.function?.name === 'browser.read');
    const searchDefinition = definitions.find(definition => definition.function?.name === 'browser.search');
    expect(readDefinition).toBeDefined();
    expect(searchDefinition).toBeDefined();
    const readParameters = readDefinition!.function!.parameters!;
    const readProperties = readParameters.properties as Record<string, Record<string, unknown>>;
    expect(readProperties).toHaveProperty('mode');
    expect(readProperties).toHaveProperty('cursor');
    expect(readProperties).not.toHaveProperty('query');
    expect(readProperties.maxChars?.maximum).toBe(12_000);
    expect(readParameters.required ?? []).not.toContain('query');
    const searchParameters = searchDefinition!.function!.parameters!;
    expect(searchParameters.required).toContain('query');

    const rejected = await tools.execute('browser.read', { query: 'exchange rates', mode: 'readable' });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(guest.browser.url).toBeUndefined();
  });

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
      toolReply('followers-text', 'browser.search', { query: 'followers count' }),
      toolReply('followers-complete', 'helm.complete', {
        response,
        requiredEffects: [{ tool: 'browser.navigate' }, { tool: 'browser.search' }],
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
      'browser.navigate', 'browser.search',
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
      toolReply('profile-text', 'browser.read', { mode: 'readable', maxChars: 12_000 }),
      toolReply('portfolio-write', 'fs.write', { path: 'twlite.html', content: portfolio }),
      toolReply('portfolio-complete', 'helm.complete', {
        response: 'Created twlite.html using the observed profile information.',
        requiredEffects: [
          { tool: 'browser.navigate' },
          { tool: 'browser.read' },
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
      'browser.navigate', 'browser.read', 'fs.write',
    ]);
    expect(requests[2]!.body.tools).toBeDefined();
    expect(JSON.stringify(requests[2]!.body.messages)).toContain(followerCount);
    expect(JSON.stringify(requests[2]!.body.messages)).toContain(repositoryName);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.navigate'))
      .toHaveLength(1);
    expect((tools.invocations.find(invocation => invocation.tool === 'browser.navigate')?.input as { url: string }).url)
      .toBe(profileUrl);
  });

  it('reads, summarizes, saves, and opens the portfolio page using separate browser operations', async () => {
    const url = 'https://dhunganakunjan.com.np/';
    const guest = new MockGuestTransport({
      pages: {
        [url]: `<!doctype html><html><head><title>Kunjan Dhungana</title></head><body><nav>Home Blog Contact</nav>
          <main><h1>Kunjan Dhungana</h1><p>Self-taught software engineer from Nepal and co-founder of Neplex.</p>
            <h2>Work</h2><p>Interested in runtimes and developer experience.</p>
            <h2>Outside software</h2><p>Slowly learning piano.</p>
            <h2>Work with me</h2><p>Book a call to discuss developer tooling.</p></main></body></html>`,
      },
    });
    const requests: CapturedRequest[] = [];
    const summary = 'Kunjan Dhungana is a self-taught software engineer from Nepal and Neplex co-founder. He is interested in runtimes and developer experience, is learning piano, and invites calls about developer tooling.';
    const { runtime, tools } = createRuntime(guest, [
      toolReply('portfolio-nav', 'browser.navigate', { url }),
      toolReply('portfolio-snapshot', 'browser.snapshot', {}),
      toolReply('portfolio-read', 'browser.read', { mode: 'readable', maxChars: 12_000 }),
      toolReply('portfolio-write', 'fs.write', { path: 'kd.txt', content: summary }),
      toolReply('portfolio-open', 'app.openFile', { path: 'kd.txt', application: 'text-editor' }),
      toolReply('portfolio-complete', 'helm.complete', {
        response: 'Saved the page summary to kd.txt and opened it in the text viewer.',
        requiredEffects: [
          { tool: 'browser.navigate' },
          { tool: 'browser.read' },
          { tool: 'fs.write' },
          { tool: 'app.openFile' },
        ],
      }),
    ], requests);

    const result = await runtime.run({
      threadId: 'portfolio-summary',
      userMessage: 'go to dhunganakunjan.com.np and summarize the page content and save it to kd.txt file and open it with text viewer app',
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/kd.txt')).toBe(summary);
    expect(guest.desktopWindows.find(window => window.focused)?.title).toContain('kd.txt');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual([
      'browser.navigate', 'browser.snapshot', 'browser.read', 'fs.write', 'app.openFile',
    ]);
    const read = tools.invocations.find(invocation => invocation.tool === 'browser.read');
    expect(read?.input).toEqual({ mode: 'readable', maxChars: 12_000 });
    expect(read?.input).not.toHaveProperty('query');
    expect(JSON.stringify(requests[3]!.body.messages)).toContain('Self-taught software engineer from Nepal');
  });

  it('does not let a zero-match search or error-file write complete a page-summary task', async () => {
    const url = 'https://dhunganakunjan.com.np/';
    const guest = new MockGuestTransport({
      pages: {
        [url]: '<html><body><main><h1>Kunjan Dhungana</h1><p>Readable portfolio content is present.</p></main></body></html>',
      },
    });
    const requests: CapturedRequest[] = [];
    const errorText = 'Error: Could not extract meaningful content from the page.';
    const completion = {
      response: 'I could not summarize the page.',
      requiredEffects: [
        { tool: 'browser.navigate' },
        { tool: 'fs.write' },
        { tool: 'app.openFile' },
      ],
    };
    const blockedResponse = 'The page has readable content, so I need to read it before saving a summary.';
    const { runtime, tools } = createRuntime(guest, [
      toolReply('failed-nav', 'browser.navigate', { url }),
      toolReply('failed-snapshot', 'browser.snapshot', {}),
      toolReply('zero-search', 'browser.search', { query: 'qzxwvv-9347182-uniquetoken' }),
      toolReply('failed-read', 'browser.read', { ref: 'r1-9999', maxChars: 5_000 }),
      toolReply('blocked-write', 'fs.write', { path: 'kd.txt', content: errorText }),
      toolReply('blocked-open', 'app.openFile', { path: 'kd.txt', application: 'text-editor' }),
      toolReply('blocked-complete', 'helm.complete', completion),
      textReply('report-blocker-1', blockedResponse),
      toolReply('finalize-blocker-1', 'helm.complete', completion),
      textReply('report-blocker-2', blockedResponse),
      toolReply('finalize-blocker-2', 'helm.complete', completion),
      textReply('report-blocker-3', blockedResponse),
      toolReply('finalize-blocker-3', 'helm.complete', completion),
      textReply('report-blocker-4', blockedResponse),
      toolReply('finalize-blocker-4', 'helm.complete', completion),
      textReply('report-blocker-final', blockedResponse),
    ], requests);

    const result = await runtime.run({
      threadId: 'unreadable-summary',
      userMessage: 'Go to dhunganakunjan.com.np, summarize the page, save it to kd.txt, and open it in a text viewer.',
    });

    expect(result.status).toBe('failed');
    expect(guest.hasFile('/home/helm/workspace/kd.txt')).toBe(false);
    expect(tools.invocations.find(invocation => invocation.tool === 'browser.search')?.result)
      .toMatchObject({ ok: true, data: { matchCount: 0, pageReadable: true } });
    expect(result.steps.find(step => step.toolName === 'browser.read')?.toolResult)
      .toMatchObject({ ok: false, error: { code: 'STALE_REGION_REF' } });
    expect(result.steps.find(step => step.toolName === 'fs.write')?.toolResult)
      .toMatchObject({ ok: false, error: { code: 'UNREAD_PAGE_CONTENT' } });
    expect(result.steps.find(step => step.toolName === 'app.openFile')?.toolResult?.ok).toBe(false);
    const searches = tools.invocations.filter(invocation => invocation.tool === 'browser.search');
    const queries = searches.map(invocation => (invocation.input as { query: string }).query.toLowerCase());
    expect(queries.every(query => !['main content', 'full content', 'page content', 'summary'].includes(query))).toBe(true);
  });

  it('remembers discovered information only after browser receipts reach the acting model', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const sourceUrl = 'https://example.test/acme/benchmark';
      const benchmark = '42.75';
      const guest = new MockGuestTransport({
        pages: {
          [sourceUrl]: '<html><body><h1>Acme Benchmark</h1><p>Current published benchmark: 42.75</p></body></html>',
        },
      });
      const requests: CapturedRequest[] = [];
      let tools: ReturnType<typeof createGuestToolRegistry> | undefined;
      const { runtime, tools: runtimeTools } = createRuntime(guest, [
        toolReply('acme-nav', 'browser.navigate', { url: sourceUrl }),
        toolReply('acme-text', 'browser.search', { query: 'published benchmark value' }),
        () => {
          const evidenceIds = tools?.invocations.flatMap(invocation => {
            const result = invocation.result;
            if (!result.ok || !result.evidence || typeof result.evidence !== 'object') return [];
            const receipt = (result.evidence as Record<string, unknown>).receipt;
            if (!receipt || typeof receipt !== 'object') return [];
            const id = (receipt as Record<string, unknown>).id;
            return typeof id === 'string' ? [id] : [];
          }) ?? [];
          return toolReply('acme-remember', 'memory.remember', {
            content: `The current Acme published benchmark is ${benchmark}.`,
            kind: 'fact',
            key: 'acme:current-benchmark',
            importance: 0.8,
            source: 'observed',
            sourceUrl,
            evidenceIds,
            durability: 'refreshable',
          });
        },
        toolReply('acme-complete', 'helm.complete', {
          response: `The current published Acme benchmark is ${benchmark}.`,
          requiredEffects: [
            { tool: 'browser.navigate' },
            { tool: 'browser.search' },
            { tool: 'memory.remember' },
          ],
        }),
      ], requests);
      tools = runtimeTools;
      registerMemoryTools(runtimeTools, memory);

      expect(memory.repository.count()).toBe(0);
      const result = await runtime.run({
        threadId: 'remember-discovered-acme',
        userMessage: `Visit ${sourceUrl}, find the current benchmark, remember it for later, and tell me the value.`,
      });

      expect(result.status).toBe('completed');
      expect(memory.repository.count()).toBe(1);
      const saved = memory.getByKey('acme:current-benchmark');
      const receiptIds = tools?.invocations.slice(0, 2).flatMap(invocation => {
        const evidence = invocation.result.evidence;
        if (!evidence || typeof evidence !== 'object') return [];
        const receipt = (evidence as Record<string, unknown>).receipt;
        if (!receipt || typeof receipt !== 'object') return [];
        const id = (receipt as Record<string, unknown>).id;
        return typeof id === 'string' ? [id] : [];
      }) ?? [];
      expect(saved).toMatchObject({
        content: `The current Acme published benchmark is ${benchmark}.`,
        source: 'observed',
        sourceUrl,
        durability: 'refreshable',
      });
      expect(saved?.evidenceIds).toEqual(receiptIds);
      expect(receiptIds).toHaveLength(2);
      expect(receiptIds.every(id => id.startsWith('receipt-'))).toBe(true);
      expect(saved?.lastVerifiedAt).toBeString();
      expect(tools?.invocations.map(invocation => invocation.tool)).toEqual([
        'browser.navigate', 'browser.search', 'memory.remember',
      ]);
      expect(requestTools(requests[0]!)).toContain('memory.remember');
      expect(JSON.stringify(requests[2]!.body.messages)).toContain(benchmark);
      expect(result.assistantResponse).toContain(benchmark);
    } finally {
      persistence.close();
    }
  });
});
