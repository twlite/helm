import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';

import { buildDuckDuckGoSearchUrl, type GuestMethod, type Memory, type TaskDefinition, type TaskRequirement } from '@helm/shared';
import { AgentRuntime } from '../../src/agent/runtime';
import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import { DeterministicTaskCompiler } from '../../src/ai/adapter';
import { MemoryService } from '../../src/memory/service';
import { registerMemoryTools } from '../../src/memory/tools';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import type { GuestMethodParams, GuestMethodResult, GuestRequestOptions } from '../../src/tools/guest-transport';
import { GuestTransportError } from '../../src/tools/guest-transport';
import { createTaskState, validateRequirementDependencies, verifyTaskState } from '../../src/agent/task-state';
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

type CapturedRequest = { body: Record<string, unknown>; reply: ChatReply };
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

function findTableRef(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try { return findTableRef(JSON.parse(value) as unknown); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findTableRef(item);
      if (result) return result;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'table' && typeof record.ref === 'string') return record.ref;
  for (const child of Object.values(record)) {
    const result = findTableRef(child);
    if (result) return result;
  }
  return undefined;
}

function findOfficialSearchRef(value: unknown, href: string): string | undefined {
  if (typeof value === 'string') {
    try { return findOfficialSearchRef(JSON.parse(value) as unknown, href); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = findOfficialSearchRef(item, href);
      if (ref) return ref;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'search_result' && record.href === href && typeof record.ref === 'string') return record.ref;
  for (const child of Object.values(record)) {
    const ref = findOfficialSearchRef(child, href);
    if (ref) return ref;
  }
  return undefined;
}

function findBrowserOpenArgs(value: unknown): { ref: string; linkIndex?: number } | undefined {
  if (typeof value === 'string') {
    try { return findBrowserOpenArgs(JSON.parse(value) as unknown); } catch {
      const match = value.match(/browser\.open\(\{ ref: "([^"]+)"(?:, linkIndex: (\d+))?/u);
      return match ? { ref: match[1]!, ...(match[2] ? { linkIndex: Number(match[2]) } : {}) } : undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findBrowserOpenArgs(item);
      if (result) return result;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  for (const child of Object.values(value as Record<string, unknown>)) {
    const result = findBrowserOpenArgs(child);
    if (result) return result;
  }
  return undefined;
}

function createRuntime(
  guest: MockGuestTransport,
  replies: ScriptedReply[],
  requests: CapturedRequest[],
  options: { maxSteps?: number; maxModelTurns?: number; memories?: Memory[] } = {},
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
      taskCompiler: new DeterministicTaskCompiler(),
      actingAgent,
      memories: options.memories,
      budgets: {
        maxSteps: options.maxSteps ?? 12,
        maxModelTurns: options.maxModelTurns ?? 12,
        maxCompletionRecoveryTurns: 2,
        maxRepeatedAction: 2,
        maxConsecutiveFailures: 3,
        toolTimeoutMs: 1_000,
      },
    }),
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

function requirementsFor(result: Awaited<ReturnType<AgentRuntime['run']>>) {
  return result.run.state?.task.requirements ?? result.task.requirements ?? [];
}

describe('production acting agent requirements', () => {
  it('completes the exact forex request through observed DuckDuckGo discovery, selected table, file, viewer, and memory', async () => {
    const persistence = testDatabase();
    try {
      const officialUrl = 'https://www.nrb.org.np/forex/';
      const wrongBankUrl = 'https://www.rbb.com.np/rates';
      const query = 'Nepal Rastra Bank official forex exchange rates';
      const searchUrl = buildDuckDuckGoSearchUrl(query);
      const rows = [
        '<tr><th>Currency</th><th>Unit</th><th>Buy</th><th>Sell</th></tr>',
        '<tr><td>USD</td><td>1</td><td>133.20</td><td>134.10</td></tr>',
        '<tr><td>EUR</td><td>1</td><td>145.25</td><td>146.80</td></tr>',
        '<tr><td>INR</td><td>100</td><td>160.00</td><td>160.15</td></tr>',
      ].join('');
      const guest = new MockGuestTransport({ pages: {
        [searchUrl]: `<html><head><title>DuckDuckGo Search</title></head><body><main>
          <article class="result"><h2><a href="${wrongBankUrl}">Rastriya Banijya Bank exchange rates</a></h2><p>Bank exchange rates.</p></article>
          <article class="result"><h2><a href="${officialUrl}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2><p>Official daily rates from Nepal Rastra Bank.</p></article>
        </main></body></html>`,
        [wrongBankUrl]: '<html><body><h1>Rastriya Banijya Bank</h1></body></html>',
        [officialUrl]: `<html><head><title>Nepal Rastra Bank Foreign Exchange</title></head><body>
          <nav><ul><li><a href="/statistics">Statistics</a></li><li><a href="/data">Data &amp; Reports</a></li><li><a href="/daily">Daily Exchange Rate</a></li></ul></nav>
          <main><h1>Foreign Exchange Rates</h1><table><caption>Daily Exchange Rates</caption>${rows}</table></main>
        </body></html>`,
      } });
      const memory = new MemoryService(persistence.sqlite);
      const requests: CapturedRequest[] = [];
      const { runtime, tools } = createRuntime(guest, [
        toolReply('early-open', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
        textReply('premature-done', 'Done.'),
        toolReply('discover', 'browser.webSearch', { query }),
        body => {
          const ref = findOfficialSearchRef(body.messages, officialUrl);
          if (!ref) throw new Error('The official observed search ref was not visible to the model.');
          return toolReply('open-official', 'browser.open', { ref });
        },
        toolReply('read-rates', 'browser.read', { query: 'exchange rate data' }),
        body => {
          const ref = findTableRef(body.messages);
          if (!ref) throw new Error('The table ref was not visible to the model.');
          return toolReply('select-table', 'browser.read', { ref });
        },
        textReply('final-forex', 'I saved the Nepal Rastra Bank exchange-rate table to forex.txt, opened it in the text viewer, and remembered the requested URL.'),
      ], requests, { maxSteps: 10, maxModelTurns: 10 });
      registerMemoryTools(tools, memory);

      const result = await runtime.run({
        threadId: 'exact-forex-regression',
        userMessage: 'fetch the exchange rate data from nepal rastra bank\'s official forex website and save that data to forex.txt file and open it with text viewer application. Use duckduckgo search to find the relevant website. remember to use https://www.nrb.org.np/forex/ for all forex requests about nepal.',
      });
      expect(result.status).toBe('completed');
      expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
        'browserSearch', 'browserResearch', 'outputFile', 'openFile', 'memoryMutation',
      ]));
      expect(requestedTools(requests[0]!)).toContain('browser.webSearch');
      expect(requestedTools(requests[0]!)).not.toContain('app.openFile');
      const actions = tools.invocations.map(item => item.tool);
      expect(actions).toEqual(['memory.remember', 'browser.webSearch', 'browser.open', 'browser.read', 'browser.read', 'fs.write', 'app.openFile']);
      expect(guest.browser.url).toBe(officialUrl);
      const saved = guest.getFile('/home/helm/workspace/forex.txt');
      expect(saved).toContain('USD | 1 | 133.20 | 134.10');
      expect(saved).toContain('EUR | 1 | 145.25 | 146.80');
      expect(saved).toContain('INR | 100 | 160.00 | 160.15');
      const file = result.run.state?.artifacts.find(item => item.path.endsWith('/forex.txt'));
      expect(file).toMatchObject({ sourceRef: expect.any(String), sourceUrl: officialUrl, sourceType: 'table', writeReceiptId: expect.any(String) });
      expect(tools.invocations.find(item => item.tool === 'fs.write')?.input).toMatchObject({ path: 'forex.txt', sourceRef: file?.sourceRef, format: 'text' });
      await expect(memory.search('forex requests about nepal')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'instruction', source: 'user', content: 'Use https://www.nrb.org.np/forex/ for all forex requests about nepal.' }),
      ]));
      expect(result.run.diagnostics).toMatchObject({ completionRejections: 0 });
      await guest.request('fs.write', { path: 'forex.txt', content: 'unrelated replacement' });
      const afterOverwrite = await verifyTaskState(result.run.task!, result.run.state!, guest, {
        timestamp: Date.now(),
        task: { completedCriteria: [], remainingCriteria: ['outputFile'] },
      });
      expect(afterOverwrite.requirements?.find(check => check.requirement.id === 'outputFile')?.passed).toBe(false);
    } finally {
      persistence.close();
    }
  });

  it('recovers when a weak model searches the already-observed URL instead of opening it', async () => {
    const persistence = testDatabase();
    try {
      const officialUrl = 'https://www.nrb.org.np/forex/';
      const query = 'Nepal Rastra Bank official forex';
      const searchUrl = buildDuckDuckGoSearchUrl(query);
      const rows = [
        '<tr><th>Currency</th><th>Unit</th><th>Buy</th><th>Sell</th></tr>',
        '<tr><td>USD</td><td>1</td><td>133.20</td><td>134.10</td></tr>',
        '<tr><td>EUR</td><td>1</td><td>145.25</td><td>146.80</td></tr>',
      ].join('');
      const guest = new MockGuestTransport({ pages: {
        [searchUrl]: `<html><head><title>DuckDuckGo Search</title></head><body><main>
          <article class="result"><h2><a href="${officialUrl}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2><p>Official daily rates.</p></article>
          <article class="result"><h2><a href="https://rates.example.test/nepal">Nepal currency rates</a></h2><p>Third party.</p></article>
        </main></body></html>`,
        [officialUrl]: `<html><head><title>Nepal Rastra Bank Foreign Exchange</title></head><body>
          <main><h1>Foreign Exchange Rates</h1><table><caption>Daily Exchange Rates</caption>${rows}</table></main>
        </body></html>`,
      } });
      const memory = new MemoryService(persistence.sqlite);
      const requests: CapturedRequest[] = [];
      const { runtime, tools } = createRuntime(guest, [
        toolReply('discover', 'browser.webSearch', { query }),
        // Weak model mistake: searches the already-observed destination URL instead of opening it.
        // The runtime must not execute a second DuckDuckGo search; the agent recovers by opening.
        toolReply('bad-url-search', 'browser.webSearch', { query: officialUrl }),
        body => {
          const ref = findOfficialSearchRef(body.messages, officialUrl);
          if (!ref) throw new Error('The official observed search ref was not visible to the model.');
          return toolReply('open-official', 'browser.open', { ref });
        },
        toolReply('read-rates', 'browser.read', { query: 'exchange rate data' }),
        body => {
          const ref = findTableRef(body.messages);
          if (!ref) throw new Error('The table ref was not visible to the model.');
          return toolReply('select-table', 'browser.read', { ref });
        },
        textReply('final-forex', 'I saved the Nepal Rastra Bank exchange-rate table to forex.txt and opened it.'),
      ], requests, { maxSteps: 12, maxModelTurns: 12 });
      registerMemoryTools(tools, memory);

      const result = await runtime.run({
        threadId: 'forex-url-as-search-recovery',
        userMessage: 'fetch the exchange rate data from nepal rastra bank\'s official forex website and save that data to forex.txt file and open it with text viewer application. Use duckduckgo search to find the relevant website. remember to use https://www.nrb.org.np/forex/ for all forex requests about nepal.',
      });
      expect(result.status).toBe('completed');
      // Only one real DuckDuckGo search may execute; the URL-as-search proposal must not create a second search loop.
      expect(tools.invocations.filter(item => item.tool === 'browser.webSearch')).toHaveLength(1);
      // The runtime directed the agent to open rather than search again.
      expect(requestedTools(requests[1]!)).toContain('browser.open');
      expect(requestedTools(requests[1]!)).not.toContain('browser.webSearch');
      expect(guest.browser.url).toBe(officialUrl);
      expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain('USD | 1 | 133.20 | 134.10');
      expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
        'browserSearch', 'browserResearch', 'outputFile', 'openFile',
      ]));
    } finally {
      persistence.close();
    }
  });

  it('does not offer a repeated search while observed results remain unopened', async () => {
    const officialUrl = 'https://www.nrb.org.np/forex/';
    const query = 'Nepal Rastra Bank official forex';
    const searchUrl = buildDuckDuckGoSearchUrl(query);
    const guest = new MockGuestTransport({ pages: {
      [searchUrl]: `<html><body><main>
        <article class="result"><h2><a href="${officialUrl}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2><p>Official.</p></article>
        <article class="result"><h2><a href="https://rates.example.test/nepal">Other</a></h2><p>Third party.</p></article>
      </main></body></html>`,
      [officialUrl]: '<html><body><main><h1>Rates</h1><p>USD 133.20</p></main></body></html>',
    } });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('discover', 'browser.webSearch', { query }),
      toolReply('repeat-search', 'browser.webSearch', { query: 'forex rates today' }),
      body => {
        const ref = findOfficialSearchRef(body.messages, officialUrl);
        if (!ref) throw new Error('Official ref not visible');
        return toolReply('open-official', 'browser.open', { ref });
      },
      toolReply('read-rates', 'browser.read', { query: 'rates' }),
      textReply('final', 'Done.'),
    ], requests, { maxSteps: 10, maxModelTurns: 10 });

    // Use a task that does not require file output so the run can finish after research.
    const result = await runtime.run({
      threadId: 'unrelated-repeat-search',
      userMessage: 'Use duckduckgo search to find Nepal Rastra Bank official forex exchange rates.',
    });
    // The SDK enforces activeTools: the repeated search proposal cannot execute a second DuckDuckGo navigation.
    expect(tools.invocations.filter(item => item.tool === 'browser.webSearch')).toHaveLength(1);
    expect(requestedTools(requests[1]!)).not.toContain('browser.webSearch');
    expect(requestedTools(requests[1]!)).toContain('browser.open');
    expect(result.status).toBe('completed');
    expect(guest.browser.url).toBe(officialUrl);
  });

  it('compiles a real task and carries browser table lineage through write and open within a small turn budget', async () => {
    const url = 'https://example.test/forex/';
    const table = '<table><tr><th>Currency</th><th>Buy</th><th>Sell</th></tr><tr><td>USD</td><td>133.20</td><td>134.10</td></tr></table>';
    const guest = new MockGuestTransport({
      pages: { [url]: `<html><body><main><h1>Exchange Rates</h1>${table}</main></body></html>` },
    });
    const requests: CapturedRequest[] = [];
    const expected = 'Exchange Rates\nCurrency | Buy | Sell\nUSD | 133.20 | 134.10';
    const { runtime, tools } = createRuntime(guest, [
      toolReply('forex-nav', 'browser.navigate', { url }),
      toolReply('forex-read', 'browser.read', { query: 'exchange rate data' }),
      body => {
        const sourceRef = findTableRef(body.messages);
        if (!sourceRef) throw new Error('The browser table ref was not returned to the acting model.');
        return toolReply('forex-select', 'browser.read', { ref: sourceRef });
      },
      textReply('forex-final', 'I saved the current exchange-rate table to forex.txt and opened it in the text viewer.'),
    ], requests, { maxSteps: 8, maxModelTurns: 8 });

    const result = await runtime.run({
      threadId: 'forex-production-compile',
      userMessage: `Fetch exchange rate data from ${url}, save that data to forex.txt, and open it with the text viewer application.`,
    });
    expect(result.status).toBe('completed');
    expect(result.task.requirements?.map(requirement => requirement.id)).toEqual(
      expect.arrayContaining(['browserResearch', 'outputFile', 'openFile']),
    );
    const requirements = result.task.requirements ?? [];
    const output = requirements.find(requirement => requirement.id === 'outputFile')!;
    const open = requirements.find(requirement => requirement.id === 'openFile')!;
    expect(output).toMatchObject({
      dependsOn: ['browserResearch'],
      target: { path: 'forex.txt', freshness: 'current-run', action: 'fs.write', mode: 'written-from-artifact' },
    });
    expect(open).toMatchObject({
      dependsOn: ['outputFile'],
      target: { path: 'forex.txt', application: 'text-editor', freshness: 'current-run', action: 'app.openFile', mode: 'opened' },
    });
    expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain(expected);
    expect(result.run.state?.artifacts.some(artifact => artifact.path?.endsWith('/forex.txt') && artifact.sourceRef)).toBe(true);
    const writeArguments = tools.invocations.find(invocation => invocation.tool === 'fs.write')?.input as Record<string, unknown>;
    expect(writeArguments).toMatchObject({ path: 'forex.txt', sourceRef: expect.any(String), format: 'text' });
    expect(writeArguments).not.toHaveProperty('content');
    expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining(['browserResearch', 'outputFile', 'openFile']));
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual([
      'browser.navigate', 'browser.read', 'browser.read', 'fs.write', 'app.openFile',
    ]);
    expect(requests).toHaveLength(4);
    expect(result.run.diagnostics).toMatchObject({ modelTurns: 4, modelRequests: 4, toolActions: 5 });
    expect(requestedTools(requests[2]!)).not.toContain('fs.write');
  });

  it('keeps artifact writing unavailable until a current-run content ref is selected', async () => {
    const url = 'https://example.test/rates';
    const guest = new MockGuestTransport({
      pages: { [url]: '<html><body><main><h1>Rates</h1><table><tr><th>Currency</th><th>Rate</th></tr><tr><td>USD</td><td>133.20</td></tr></table></main></body></html>' },
    });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('rates-nav', 'browser.navigate', { url }),
      toolReply('rates-read', 'browser.read', { query: 'exchange rates' }),
      body => {
        const sourceRef = findTableRef(body.messages);
        if (!sourceRef) throw new Error('The read table ref was not returned to the acting model.');
        return toolReply('rates-select', 'browser.read', { ref: sourceRef });
      },
      textReply('rates-final', 'I saved the observed rates to rates.txt.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'browser-read-prerequisite',
      userMessage: `Read ${url}, save the data to rates.txt.`,
    });
    expect(result.status).toBe('completed');
    expect(requestedTools(requests[1]!)).not.toContain('fs.write');
    expect(requestedTools(requests[2]!)).not.toContain('fs.write');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['browser.navigate', 'browser.read', 'browser.read', 'fs.write']);
    expect(guest.getFile('/home/helm/workspace/rates.txt')).toContain('USD | 133.20');
    expect(requests).toHaveLength(4);
  });

  it('rejects open-before-write and ignores an old file and already-open window', async () => {
    const guest = new MockGuestTransport({ initialFiles: { '/home/helm/workspace/forex.txt': 'OLD DATA' } });
    await guest.request('app.openFile', { path: 'forex.txt', application: 'text-editor' });
    const oldWindowCount = guest.desktopWindows.length;
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      textReply('early-claim', 'forex.txt is already open, so the task is done.'),
      toolReply('fresh-write', 'fs.write', { path: 'forex.txt', content: 'NEW DATA' }),
      textReply('after-open', 'I wrote the new contents and opened forex.txt during this run.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'current-run-open',
      userMessage: 'Write new text to forex.txt and open it in the text viewer.',
    });

    expect(result.status).toBe('completed');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['fs.write', 'app.openFile']);
    expect(tools.invocations.find(invocation => invocation.tool === 'fs.write')?.input).toMatchObject({ path: 'forex.txt' });
    expect(guest.getFile('/home/helm/workspace/forex.txt')).toBe('NEW DATA');
    expect(guest.desktopWindows.length).toBeGreaterThanOrEqual(oldWindowCount);
    expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining(['outputFile', 'openFile']));
    expect(requestedTools(requests[0]!)).toContain('fs.write');
    expect(requestedTools(requests[0]!)).not.toContain('app.openFile');
    expect(result.steps.find(step => step.toolName === 'app.openFile')?.stepIndex)
      .toBeGreaterThan(result.steps.find(step => step.toolName === 'fs.write')?.stepIndex ?? -1);
  });

  it('does not let an unrelated write satisfy the compiled output requirement or accept a model claim', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('wrong-path', 'fs.write', { path: 'other.txt', content: 'unrelated' }),
      toolReply('correct-path', 'fs.write', { path: 'forex.txt', content: 'requested data' }),
      textReply('saved', 'The requested data is saved to forex.txt.'),
    ], requests);

    const result = await runtime.run({ threadId: 'wrong-output-path', userMessage: 'Write the requested data to forex.txt.' });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/other.txt')).toBe('unrelated');
    expect(guest.getFile('/home/helm/workspace/forex.txt')).toBe('requested data');
    expect(requirementsFor(result).find(requirement => requirement.id === 'outputFile')?.status).toBe('satisfied');
    expect(result.run.diagnostics).toMatchObject({ completionRejections: 0, toolActions: 2 });
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['fs.write', 'fs.write']);
  });

  it('finishes an explicit memory mutation in two model requests without a completion ceremony', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const guest = new MockGuestTransport();
      const requests: CapturedRequest[] = [];
      const { runtime, tools } = createRuntime(guest, [
        textReply('memory-final', 'I will use that source for Nepal forex requests.'),
      ], requests, { maxModelTurns: 6 });
      registerMemoryTools(tools, memory);

      const result = await runtime.run({
        threadId: 'memory-action-budget',
        userMessage: 'Remember to use https://www.nrb.org.np/forex/ for all forex requests about Nepal.',
      });

      expect(result.status).toBe('completed');
      await expect(memory.search('Nepal forex requests')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'Use https://www.nrb.org.np/forex/ for all forex requests about Nepal.' }),
      ]));
      expect(requirementsFor(result).find(requirement => requirement.id === 'memoryMutation')?.status).toBe('satisfied');
      expect(requests).toHaveLength(1);
      expect(result.run.diagnostics).toMatchObject({ modelTurns: 1, modelRequests: 1, toolActions: 1 });
      expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['memory.remember']);
    } finally {
      persistence.close();
    }
  });

  it('keeps normal chat to one model request and no computer actions', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [textReply('hello', 'Hello!')], requests);

    const result = await runtime.run({ threadId: 'cheap-chat', userMessage: 'hello' });

    expect(result.status).toBe('completed');
    expect(result.assistantResponse).toBe('Hello!');
    expect(requests).toHaveLength(1);
    expect(result.run.diagnostics).toMatchObject({ modelTurns: 1, modelRequests: 1, toolActions: 0, contextCompactions: 0 });
    expect(tools.invocations).toHaveLength(0);
    expect(guest.desktopWindows).toHaveLength(0);
    expect(guest.browser.url).toBeUndefined();
  });

  it('keeps an ordinary creative-writing request in conversation mode', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [textReply('poem', 'A small poem about rain.')], requests);

    const result = await runtime.run({ threadId: 'poem-conversation', userMessage: 'Write me a poem.' });

    expect(result.status).toBe('completed');
    expect(result.task.isConversation).toBe(true);
    expect(result.task.requirements).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(tools.invocations).toHaveLength(0);
  });

  it('compiles an explicit application launch as a current-run action requirement', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('launch-editor', 'app.launch', { application: 'text-editor' }),
      textReply('launch-final', 'The text editor is open.'),
    ], requests);

    const result = await runtime.run({ threadId: 'explicit-app-launch', userMessage: 'Launch the text editor.' });

    expect(result.status).toBe('completed');
    expect(result.task.requirements).toContainEqual(expect.objectContaining({
      id: 'applicationLaunch',
      target: { application: 'text-editor', freshness: 'current-run', action: 'app.launch' },
    }));
    expect(result.run.state?.completedRequirementIds).toContain('applicationLaunch');
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual(['app.launch']);
    expect(requests).toHaveLength(2);
  });

  it('records the effective DuckDuckGo navigation separately from an unobserved model proposal', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const proposedUrl = 'https://www.nbr.gov.np/forex';
    const { runtime } = createRuntime(guest, [
      toolReply('unobserved-nav', 'browser.navigate', { url: proposedUrl }),
      textReply('nav-final-one', 'I started with search discovery.'),
      textReply('nav-final-two', 'I could not finish the remaining research.'),
      textReply('nav-final-three', 'The source still needs inspection.'),
    ], requests);

    const result = await runtime.run({ threadId: 'effective-navigation', userMessage: 'Use the web to find current Nepal forex exchange rates.' });

    const nav = result.steps.find(step => step.toolName === 'browser.navigate');
    expect(nav?.decision?.type).toBe('action');
    expect(nav?.decision?.type === 'action' ? nav.decision.input.url : undefined).toBe(proposedUrl);
    expect(nav?.toolInput?.url).toContain('duckduckgo.com/?q=');
    expect(nav?.toolInput?.url).not.toBe(proposedUrl);
    expect(nav?.toolResult?.data).toMatchObject({ url: nav?.toolInput?.url, proposedUrl });
  });

  it('requires browser.open refs after a search or page read observes a destination', async () => {
    const sourceUrl = 'https://example.test/start';
    const targetUrl = 'https://example.test/rates/';
    const guest = new MockGuestTransport({ pages: {
      [sourceUrl]: '<html><body><main><h1>Forex</h1><a href="https://example.test/rates/">Current rates</a></main></body></html>',
      [targetUrl]: '<html><body><main><h1>Current rates</h1><p>USD 133.20</p></main></body></html>',
    } });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('source-nav', 'browser.navigate', { url: sourceUrl }),
      toolReply('source-read', 'browser.read', { query: 'current rates link' }),
      toolReply('copied-href', 'browser.navigate', { url: targetUrl }),
      body => {
        const observed = findBrowserOpenArgs(body.messages);
        if (!observed) throw new Error('The runtime did not provide the observed semantic ref to recover navigation.');
        return toolReply('open-observed-ref', 'browser.open', observed);
      },
      toolReply('rates-read', 'browser.read', { query: 'USD rate' }),
      textReply('opened-result', 'I opened the observed current rates result.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'semantic-ref-navigation',
      userMessage: `Open ${sourceUrl} and follow its current rates link.`,
    });

    expect(result.status).toBe('completed');
    expect(result.steps.find(step => step.toolName === 'browser.navigate' && step.toolResult?.error?.code === 'OBSERVED_DESTINATION_REQUIRES_REF'))
      .toBeDefined();
    expect(tools.invocations.map(invocation => invocation.tool)).toEqual([
      'browser.navigate', 'browser.read', 'browser.open', 'browser.read',
    ]);
    expect(tools.invocations[2]?.input).toMatchObject({ ref: expect.any(String), linkIndex: expect.any(Number) });
    expect(guest.browser.url).toBe(targetUrl);
  });

  it('uses an exact verified-memory URL directly before search discovery', async () => {
    const url = 'https://www.nrb.org.np/forex/';
    const verifiedAt = '2026-09-27T00:00:00.000Z';
    const memory: Memory = {
      id: 'memory-nepal-forex',
      key: 'nepal_forex_url',
      content: `Use ${url} for all forex requests about Nepal.`,
      kind: 'instruction',
      importance: 0.9,
      metadata: {},
      source: 'observed',
      sourceUrl: url,
      evidenceIds: ['receipt-verified-memory'],
      durability: 'refreshable',
      lastVerifiedAt: verifiedAt,
      createdAt: verifiedAt,
      updatedAt: verifiedAt,
    };
    const guest = new MockGuestTransport({ pages: { [url]: '<html><body><main><h1>Nepal Foreign Exchange Rates</h1><p>USD buying rate: 133.20</p></main></body></html>' } });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('verified-nav', 'browser.navigate', { url }),
      toolReply('verified-read', 'browser.read', { query: 'forex rates' }),
      textReply('verified-final', 'The verified Nepal Rastra Bank page lists the current rate data.'),
    ], requests, { memories: [memory] });

    const result = await runtime.run({ threadId: 'verified-memory-url', userMessage: 'Use the web to find current Nepal forex exchange rates.' });

    expect(result.status).toBe('completed');
    expect((tools.invocations[0]?.input as { url: string }).url).toBe(url);
    expect(tools.invocations.some(invocation => (invocation.input as { url?: string }).url?.includes('duckduckgo.com'))).toBe(false);
    expect(result.steps.find(step => step.toolName === 'browser.navigate')?.toolResult?.data)
      .toMatchObject({ url, urlProvenance: 'verified-memory' });
  });

  it('accepts a blocker only when the pending output requirement has a matching failed receipt', async () => {
    class DiskFullGuest extends MockGuestTransport {
      override async request<M extends GuestMethod>(
        method: M,
        params: GuestMethodParams[M],
        options?: GuestRequestOptions,
      ): Promise<GuestMethodResult[M]> {
        if (method === 'fs.write') throw new GuestTransportError('DISK_FULL', 'The guest could not store the file.');
        return super.request(method, params, options);
      }
    }
    const guest = new DiskFullGuest();
    const requests: CapturedRequest[] = [];
    const { runtime } = createRuntime(guest, [
      toolReply('failed-output', 'fs.write', { path: 'forex.txt', content: 'new data' }),
      toolReply('verified-blocker', 'helm.blocked', {
        response: 'I could not save forex.txt because the guest filesystem reported that it is full.',
        requirementIds: ['outputFile'],
      }),
    ], requests);

    const result = await runtime.run({ threadId: 'verified-blocker', userMessage: 'Write new data to forex.txt.' });

    expect(result.status).toBe('blocked');
    expect(result.assistantResponse).toContain('filesystem reported that it is full');
    expect(result.run.error).toMatchObject({ code: 'TASK_BLOCKED' });
    expect(result.run.state?.blockers.at(-1)?.requirementIds).toEqual(['outputFile']);
    expect(result.steps.find(step => step.toolName === 'fs.write')?.toolResult)
      .toMatchObject({ ok: false, error: { code: 'DISK_FULL' } });
    expect(requests).toHaveLength(2);
  });

  it('classifies a DuckDuckGo challenge as a terminal search strategy without another search turn', async () => {
    class ChallengedGuest extends MockGuestTransport {
      override async request<M extends GuestMethod>(
        method: M, params: GuestMethodParams[M], options?: GuestRequestOptions,
      ): Promise<GuestMethodResult[M]> {
        if (method === 'browser.webSearch') throw new GuestTransportError('WEB_SEARCH_CHALLENGE', 'DuckDuckGo presented a human challenge.');
        return super.request(method, params, options);
      }
    }
    const guest = new ChallengedGuest();
    const requests: CapturedRequest[] = [];
    const { runtime } = createRuntime(guest, [
      toolReply('search-challenged', 'browser.webSearch', { query: 'Nepal Rastra Bank forex rates' }),
      toolReply('search-blocked', 'helm.blocked', {
        response: 'DuckDuckGo presented a human challenge, so I could not observe search results.',
        requirementIds: ['browserSearch'],
      }),
    ], requests);
    const result = await runtime.run({
      threadId: 'challenge-search',
      userMessage: 'Use DuckDuckGo search to find current exchange rates.',
    });
    expect(result.status).toBe('blocked');
    expect(result.steps.filter(step => step.toolName === 'browser.webSearch')).toHaveLength(1);
    expect(requestedTools(requests[1]!)).not.toContain('browser.webSearch');
    expect(requestedTools(requests[1]!)).toContain('helm.blocked');
    expect(result.run.error).toMatchObject({ code: 'TASK_BLOCKED' });
  });

  it('persists the exact forex memory and cleanly blocks the dependent flow on a live-style challenge', async () => {
    class ChallengedGuest extends MockGuestTransport {
      override async request<M extends GuestMethod>(
        method: M, params: GuestMethodParams[M], options?: GuestRequestOptions,
      ): Promise<GuestMethodResult[M]> {
        if (method === 'browser.webSearch') throw new GuestTransportError('WEB_SEARCH_CHALLENGE', 'DuckDuckGo presented a human challenge.');
        return super.request(method, params, options);
      }
    }
    const persistence = testDatabase();
    try {
      const guest = new ChallengedGuest();
      const memory = new MemoryService(persistence.sqlite);
      const requests: CapturedRequest[] = [];
      const { runtime, tools } = createRuntime(guest, [
        toolReply('forex-challenged', 'browser.webSearch', { query: 'Nepal Rastra Bank forex rates' }),
        toolReply('forex-search-blocked', 'helm.blocked', {
          response: 'DuckDuckGo presented a human challenge, so I could not obtain observed results or save the forex data.',
          requirementIds: ['browserSearch'],
        }),
      ], requests);
      registerMemoryTools(tools, memory);
      const result = await runtime.run({
        threadId: 'forex-challenge',
        userMessage: 'fetch the exchange rate data from nepal rastra bank\'s official forex website and save that data to forex.txt file and open it with text viewer application. Use duckduckgo search to find the relevant website. remember to use https://www.nrb.org.np/forex/ for all forex requests about nepal.',
      });
      expect(result.status).toBe('blocked');
      expect(result.run.task?.requirements?.some(item => item.id.startsWith('browserDestination'))).toBe(false);
      expect(result.run.state?.completedRequirementIds).toContain('memoryMutation');
      expect(result.run.state?.completedRequirementIds).not.toContain('outputFile');
      expect(result.run.state?.completedRequirementIds).not.toContain('openFile');
      expect(result.run.diagnostics?.modelTurns).toBe(2);
      expect(requestedTools(requests[1]!)).not.toContain('browser.webSearch');
      await expect(memory.search('forex requests about nepal')).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ content: 'Use https://www.nrb.org.np/forex/ for all forex requests about nepal.' }),
      ]));
    } finally {
      persistence.close();
    }
  });

  it('bounds a failed search strategy across changed query arguments', async () => {
    class UnreachableSearchGuest extends MockGuestTransport {
      override async request<M extends GuestMethod>(
        method: M, params: GuestMethodParams[M], options?: GuestRequestOptions,
      ): Promise<GuestMethodResult[M]> {
        if (method === 'browser.webSearch') throw new GuestTransportError('BROWSER_TIMEOUT', 'DuckDuckGo could not load.');
        return super.request(method, params, options);
      }
    }
    const guest = new UnreachableSearchGuest();
    const requests: CapturedRequest[] = [];
    const { runtime } = createRuntime(guest, [
      toolReply('search-failed-1', 'browser.webSearch', { query: 'Nepal Rastra Bank forex rates' }),
      toolReply('search-failed-2', 'browser.webSearch', { query: 'NRB official forex' }),
      toolReply('search-terminal', 'helm.blocked', {
        response: 'DuckDuckGo could not load after bounded attempts.',
        requirementIds: ['browserSearch'],
      }),
    ], requests);
    const result = await runtime.run({
      threadId: 'navigation-failed-search',
      userMessage: 'Use DuckDuckGo search to find current exchange rates.',
    });
    expect(result.status).toBe('blocked');
    expect(result.steps.filter(step => step.toolName === 'browser.webSearch')).toHaveLength(2);
    expect(requestedTools(requests[2]!)).not.toContain('browser.webSearch');
    expect(requestedTools(requests[2]!)).toContain('helm.blocked');
    expect(result.run.diagnostics?.modelTurns).toBe(3);
  });

  it('does not accept an empty successful search response as discovery', async () => {
    class EmptySearchGuest extends MockGuestTransport {
      override async request<M extends GuestMethod>(
        method: M, params: GuestMethodParams[M], options?: GuestRequestOptions,
      ): Promise<GuestMethodResult[M]> {
        if (method === 'browser.webSearch') {
          const query = (params as GuestMethodParams['browser.webSearch']).query;
          const url = buildDuckDuckGoSearchUrl(query);
          return {
            operation: 'web_search', searchEngine: 'duckduckgo', searchCompleted: true,
            requestedUrl: url, url, title: 'DuckDuckGo', revision: 1, query,
            semanticBlockCount: 0, matchCount: 0, pageReadable: true,
            message: 'No result refs were observed.', results: [],
          } as GuestMethodResult[M];
        }
        return super.request(method, params, options);
      }
    }
    const requests: CapturedRequest[] = [];
    const { runtime } = createRuntime(new EmptySearchGuest(), [
      toolReply('empty-search', 'browser.webSearch', { query: 'current exchange rates' }),
      toolReply('empty-search-blocker', 'helm.blocked', {
        response: 'The browser returned no observed search result refs.',
        requirementIds: ['browserSearch'],
      }),
    ], requests);
    const result = await runtime.run({ threadId: 'empty-search', userMessage: 'Use DuckDuckGo search to find current exchange rates.' });
    expect(result.status).toBe('blocked');
    expect(result.steps.find(step => step.toolName === 'browser.webSearch')?.toolResult)
      .toMatchObject({ ok: false, error: { code: 'WEB_SEARCH_PARSE_FAILED' } });
    expect(requestedTools(requests[1]!)).not.toContain('browser.webSearch');
  });

  it('rejects cyclic dependency graphs before a task can run', () => {
    const requirement = (id: string, dependsOn: string[]): TaskRequirement => ({
      id,
      description: id,
      type: 'semantic',
      mandatory: true,
      status: 'pending',
      dependsOn,
    });

    expect(() => validateRequirementDependencies([
      requirement('first', ['second']),
      requirement('second', ['first']),
    ])).toThrow(/dependency cycle/u);
  });

  it('compiles directory-to-file and download-to-open dependencies generically', async () => {
    const compiler = new DeterministicTaskCompiler();
    const directoryTask = await compiler.createTask({
      threadId: 'directory-dependency',
      userMessage: 'Create the directory ~/Desktop/reports and write notes.txt in it.',
    });
    const downloadTask = await compiler.createTask({
      threadId: 'download-dependency',
      userMessage: 'Download the report and open it in the text viewer.',
    });

    expect(directoryTask.requirements?.find(requirement => requirement.id === 'outputFile')?.dependsOn)
      .toContain('outputDirectory');
    expect(downloadTask.requirements?.find(requirement => requirement.id === 'openFile')?.dependsOn)
      .toContain('downloadArtifact');
  });

  it('requires a downloaded artifact itself to be opened when its filename is discovered at runtime', async () => {
    const task: TaskDefinition = {
      id: 'download-open-task',
      threadId: 'download-open-task',
      goal: 'Download the report and open it in the text viewer.',
      originalRequest: 'Download the report and open it in the text viewer.',
      criteria: [],
      requirements: [
        { id: 'downloadArtifact', description: 'Download the requested artifact.', type: 'artifact', mandatory: true, target: { mode: 'downloaded' } },
        { id: 'openFile', description: 'Open the downloaded artifact.', type: 'desktop', mandatory: true, dependsOn: ['downloadArtifact'], target: { mode: 'opened', freshness: 'current-run', action: 'app.openFile', application: 'text-editor' } },
      ],
    };
    const state = createTaskState(task);
    const downloadedPath = '/home/helm/Downloads/monthly-report.pdf';
    state.artifacts.push({
      id: 'download-artifact',
      type: 'download',
      path: downloadedPath,
      download: { sourceUrl: 'https://example.test/report.pdf', savedPath: downloadedPath, startedAt: new Date().toISOString() },
      observedAt: new Date().toISOString(),
    });
    state.recentActions.push({
      id: 'open-wrong-download',
      tool: 'app.openFile',
      input: { path: '/home/helm/Downloads/other-report.pdf', application: 'text-editor' },
      result: { ok: true, data: { path: '/home/helm/Downloads/other-report.pdf', application: 'text-editor' } },
      receipt: {
        id: 'open-wrong-receipt',
        tool: 'app.openFile',
        ok: true,
        effect: { path: '/home/helm/Downloads/other-report.pdf' },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    const guest = new MockGuestTransport();
    const observation = {
      timestamp: 1,
      desktop: { windows: [{ id: 'text-editor', title: 'other-report.pdf - Text Editor', focused: true }] },
      task: { completedCriteria: [], remainingCriteria: ['downloadArtifact', 'openFile'] },
    };

    const wrongFileVerification = await verifyTaskState(task, state, guest, observation);
    expect(wrongFileVerification.requirements?.find(check => check.requirement.id === 'downloadArtifact')?.passed).toBe(true);
    expect(wrongFileVerification.requirements?.find(check => check.requirement.id === 'openFile')?.passed).toBe(false);

    state.recentActions[0]!.input.path = downloadedPath;
    state.recentActions[0]!.result.data = { path: downloadedPath, application: 'text-editor' };
    state.recentActions[0]!.receipt!.effect!.path = downloadedPath;
    observation.desktop.windows[0]!.title = 'monthly-report.pdf - Text Editor';
    const matchingFileVerification = await verifyTaskState(task, state, guest, observation);
    expect(matchingFileVerification.complete).toBe(true);
    expect(matchingFileVerification.requirements?.find(check => check.requirement.id === 'openFile')?.passed).toBe(true);
  });
});
