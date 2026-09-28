import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';
import type { BrowserReadResult, GuestMethod } from '@helm/shared';

import { AgentRuntime } from '../../src/agent/runtime';
import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import { DeterministicTaskCompiler } from '../../src/ai/adapter';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import type { GuestMethodParams, GuestMethodResult, GuestRequestOptions } from '../../src/tools/guest-transport';
import { MemoryService } from '../../src/memory/service';
import { registerMemoryTools } from '../../src/memory/tools';
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

function findTableRef(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try { return findTableRef(JSON.parse(value) as unknown); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = findTableRef(item);
      if (ref) return ref;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'table' && typeof record.ref === 'string') return record.ref;
  for (const child of Object.values(record)) {
    const ref = findTableRef(child);
    if (ref) return ref;
  }
  return undefined;
}

function findQueryAttribute(value: unknown, attribute: string): string | undefined {
  if (typeof value === 'string') {
    try { return findQueryAttribute(JSON.parse(value) as unknown, attribute); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findQueryAttribute(item, attribute);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const attributes = record.attributes;
  if (typeof attributes === 'object' && attributes !== null) {
    const result = (attributes as Record<string, unknown>)[attribute];
    if (typeof result === 'string') return result;
  }
  for (const child of Object.values(record)) {
    const found = findQueryAttribute(child, attribute);
    if (found) return found;
  }
  return undefined;
}

function findQueryRowTexts(value: unknown): string[] {
  if (typeof value === 'string') {
    try { return findQueryRowTexts(JSON.parse(value) as unknown); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(findQueryRowTexts);
  if (typeof value !== 'object' || value === null) return [];
  const record = value as Record<string, unknown>;
  if (record.tag === 'tr' && record.role === 'row' && typeof record.text === 'string') return [record.text];
  return Object.values(record).flatMap(findQueryRowTexts);
}

function findReadTableSummary(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { return findReadTableSummary(JSON.parse(value) as unknown); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const table = findReadTableSummary(item);
      if (table) return table;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === 'table') return record;
  for (const child of Object.values(record)) {
    const table = findReadTableSummary(child);
    if (table) return table;
  }
  return undefined;
}

class PartialSemanticReadGuest extends MockGuestTransport {
  private returnedPartialTable = false;

  override async request<M extends GuestMethod>(
    method: M,
    params: GuestMethodParams[M],
    options: GuestRequestOptions = {},
  ): Promise<GuestMethodResult[M]> {
    const result = await super.request(method, params, options);
    if (method !== 'browser.read' || this.returnedPartialTable) return result;
    this.returnedPartialTable = true;
    const read = result as BrowserReadResult;
    return {
      ...read,
      blocks: read.blocks?.map(block => block.type === 'table'
        ? { ...block, rows: block.rows?.slice(0, 1), rowCount: 1, truncated: true }
        : block),
    } as GuestMethodResult[M];
  }
}

function createRuntime(
  guest: MockGuestTransport,
  replies: ScriptedReply[],
  requests: CapturedRequest[],
  memory?: MemoryService,
) {
  const provider = createOpenAICompatible({
    name: 'acting-agent-test',
    baseURL: 'http://localhost:1234/v1',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      const scripted = replies.shift();
      if (!scripted) throw new Error('The test model has no scripted reply remaining.');
      const reply = typeof scripted === 'function' ? scripted(body) : scripted;
      requests.push({ body, reply });
      return Response.json(reply);
    },
  });
  const tools = createGuestToolRegistry(guest);
  if (memory) registerMemoryTools(tools, memory);
  const actingAgent = new AiSdkActingAgent({
    model: provider.chatModel('acting-agent-test-model'),
    maxOutputTokens: 4_000,
    temperature: 0,
    requestTimeoutMs: 1_000,
  });
  const runtime = new AgentRuntime({
    guestTransport: guest,
    toolRegistry: tools,
    verifier: new CriterionVerifierRegistry(guest),
    taskCompiler: new DeterministicTaskCompiler(),
    actingAgent,
    budgets: {
      maxSteps: 14,
      maxModelTurns: 12,
      maxCompletionRecoveryTurns: 2,
      maxRepeatedAction: 2,
      maxConsecutiveFailures: 3,
      toolTimeoutMs: 1_000,
    },
  });
  return { runtime, tools };
}

describe('production acting-agent outcomes', () => {
  it('navigates, extracts a table, writes its content ref directly, and opens the file', async () => {
    const url = 'https://fixture.example.test/rates';
    const guest = new MockGuestTransport({
      pages: {
        [url]: `<!doctype html><html><head><title>Daily Rates</title></head><body><main>
          <h1>Daily Exchange Rates</h1>
          <table><caption>Rates for today</caption><tr><th>Currency</th><th>Buy</th><th>Sell</th></tr>
            <tr><td>USD</td><td>133.20</td><td>134.10</td></tr>
            <tr><td>EUR</td><td>145.25</td><td>146.80</td></tr>
          </table>
        </main></body></html>`,
      },
    });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('navigate', 'browser.navigate', { url }),
      toolReply('extract', 'browser.read', { query: 'exchange rate table' }),
      body => {
        const sourceRef = findTableRef(body.messages);
        if (!sourceRef) throw new Error('The extracted table content ref was not returned to the model.');
        return toolReply('write', 'fs.write', { path: 'forex.txt', sourceRef, format: 'text' });
      },
      toolReply('open', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
      textReply('done', 'I saved the extracted rates to forex.txt and opened it in the text viewer.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'navigate-extract-save-open',
      userMessage: `Go to ${url}, extract the exchange rate table, save it to forex.txt and open it with the text viewer.`,
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain('USD | 133.20 | 134.10');
    expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain('EUR | 145.25 | 146.80');
    const actions = result.run.state?.durableActions ?? [];
    const write = actions.find(action => action.tool === 'fs.write');
    const open = actions.find(action => action.tool === 'app.openFile');
    expect(write?.result.ok).toBe(true);
    expect(write?.receipt).toMatchObject({ tool: 'fs.write', ok: true });
    expect(open?.result.ok).toBe(true);
    expect(open?.receipt).toMatchObject({ tool: 'app.openFile', ok: true });
    expect(guest.desktopWindows).toContainEqual(expect.objectContaining({
      application: 'text-editor',
      title: expect.stringContaining('forex.txt'),
    }));
    const writeInput = tools.invocations.find(invocation => invocation.tool === 'fs.write')?.input as Record<string, unknown>;
    expect(writeInput).toMatchObject({ path: 'forex.txt', sourceRef: expect.stringMatching(/^c\d+-/u), format: 'text' });
    expect(writeInput).not.toHaveProperty('content');
    expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
      'browserVisited1', 'browserEvidence', 'outputFile', 'openFile',
    ]));
    expect(requests.at(-1)?.body.tool_choice).toBe('auto');
    expect(JSON.stringify(requests[0]?.body)).toContain('another browser.read of that ref is unnecessary');
    expect(JSON.stringify(requests[0]?.body)).toContain('Use app.launch only when the user asks to start an application without a file');
    expect(JSON.stringify(requests[0]?.body)).toContain('Use app.openFile for an existing file');
    expect(result.run.diagnostics?.modelTurns).toBe(5);
    expect(result.run.diagnostics?.modelRequestOutcomes?.map(outcome => outcome.outcome)).toEqual([
      'tool-call', 'tool-call', 'tool-call', 'tool-call', 'assistant-text',
    ]);
    expect(tools.invocations.some(invocation => invocation.tool === 'app.launch')).toBe(false);
  });

  it('recovers from partial semantic table output with DOM inspection, remembers, writes, and opens inside the normal turn budget', async () => {
    const url = 'https://fixture.example.test/dynamic-rates';
    const guest = new PartialSemanticReadGuest({
      pages: {
        [url]: `<!doctype html><html><head><title>Current Rates</title></head><body><main>
          <h1>Current exchange rates</h1>
          <table id="rates"><thead><tr><th>Currency</th><th>Unit</th><th>Buy</th><th>Sell</th></tr></thead><tbody>
            <tr><td>INR (Indian Rupee)</td><td>100</td><td>160.00</td><td>160.15</td></tr>
            <tr><td>USD (U.S. Dollar)</td><td>1</td><td>153.01</td><td>153.61</td></tr>
            <tr><td>EUR (European Euro)</td><td>1</td><td>174.30</td><td>174.98</td></tr>
          </tbody></table>
        </main></body></html>`,
      },
    });
    const persistence = testDatabase();
    try {
      const requests: CapturedRequest[] = [];
      const memory = new MemoryService(persistence.sqlite);
      const { runtime, tools } = createRuntime(guest, [
        toolReply('navigate', 'browser.navigate', { url }),
        toolReply('partial-read', 'browser.read', { mode: 'document' }),
        body => {
          const table = findReadTableSummary(body.messages);
          if (!table || table.rowCount !== 1) throw new Error('The initial semantic read was not partial.');
          return toolReply('inspect-all-rows', 'browser.query', { selector: '#rates tbody tr', limit: 20 });
        },
        toolReply('remember-source', 'memory.remember', {
          content: `Use ${url} for all forex requests about Nepal.`,
          kind: 'instruction',
          source: 'user',
        }),
        body => {
          const rows = findQueryRowTexts(body.messages).filter(row => !row.startsWith('Currency '));
          if (rows.length !== 3) throw new Error(`Expected three inspected currency rows, received ${rows.length}.`);
          return toolReply('write-all-rates', 'fs.write', {
            path: 'forex.txt',
            content: `Currency | Unit | Buy | Sell\n${rows.join('\n')}`,
          });
        },
        toolReply('open-rates', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
        textReply('done', 'I saved the exchange rates to forex.txt and opened it in the text viewer.'),
      ], requests, memory);

      const result = await runtime.run({
        threadId: 'dynamic-table-full-effect-scenario',
        userMessage: `Fetch the exchange rate data from the official forex website at ${url}, save it to forex.txt and open it with the text viewer. Remember to use that site for all forex requests about Nepal in the future.`,
      });

      expect(result.status).toBe('completed');
      expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain('INR (Indian Rupee) 100 160.00 160.15');
      expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain('USD (U.S. Dollar) 1 153.01 153.61');
      expect(guest.getFile('/home/helm/workspace/forex.txt')).toContain('EUR (European Euro) 1 174.30 174.98');
      const actions = result.run.state?.durableActions ?? [];
      expect(actions.find(action => action.tool === 'memory.remember')).toMatchObject({
        result: { ok: true, data: { action: 'remembered' } },
        receipt: { tool: 'memory.remember', ok: true, effect: { changed: true } },
      });
      expect(actions.find(action => action.tool === 'fs.write')?.receipt).toMatchObject({
        tool: 'fs.write', ok: true, effect: { path: '/home/helm/workspace/forex.txt', writePerformed: true },
      });
      expect(actions.find(action => action.tool === 'app.openFile')?.receipt).toMatchObject({
        tool: 'app.openFile', ok: true,
        effect: { path: '/home/helm/workspace/forex.txt', application: 'text-editor' },
      });
      expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
        'browserVisited1', 'browserEvidence', 'memoryMutation', 'outputFile', 'openFile',
      ]));
      expect(tools.invocations.some(invocation => invocation.tool === 'app.launch')).toBe(false);
      expect(guest.desktopWindows).toContainEqual(expect.objectContaining({
        application: 'text-editor',
        title: expect.stringContaining('forex.txt'),
      }));
      expect(result.run.diagnostics?.modelTurns).toBeLessThan(12);
      expect(result.run.diagnostics?.modelTurns).toBe(7);
      expect(result.run.diagnostics?.toolActions).toBe(6);
      expect(result.run.diagnostics?.modelRequestOutcomes).toHaveLength(7);
      expect(requests.at(-1)?.body.tool_choice).toBe('auto');
    } finally {
      persistence.close();
    }
  });

  it('recovers from a real FILE_NOT_FOUND result when it tries opening before writing', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('open-missing', 'app.openFile', { path: 'notes.txt', application: 'text-editor' }),
      toolReply('write-notes', 'fs.write', { path: 'notes.txt', content: 'Today I reviewed the project notes.' }),
      toolReply('open-created', 'app.openFile', { path: 'notes.txt', application: 'text-editor' }),
      textReply('done', 'I wrote notes.txt and opened it in the text editor.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'open-before-write-recovery',
      userMessage: 'Write the project notes to notes.txt and open it in the text editor.',
    });

    expect(result.status).toBe('completed');
    const opens = tools.invocations.filter(invocation => invocation.tool === 'app.openFile');
    expect(opens).toHaveLength(2);
    expect(opens[0]?.result).toMatchObject({ ok: false, error: { code: 'FILE_NOT_FOUND' } });
    expect(opens[1]?.result.ok).toBe(true);
    expect(JSON.stringify(requests[1]?.body.messages)).toContain('FILE_NOT_FOUND');
    expect(guest.getFile('/home/helm/workspace/notes.txt')).toBe('Today I reviewed the project notes.');
  });

  it('uses browser.query when the requested value is stored in a data attribute', async () => {
    const url = 'https://fixture.example.test/metadata';
    const guest = new MockGuestTransport({
      pages: {
        [url]: '<!doctype html><html><head><title>Quote</title></head><body><div id="rate" data-currency="USD" data-rate="133.20">Current market snapshot</div></body></html>',
      },
    });
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('navigate', 'browser.navigate', { url }),
      toolReply('query-hidden-data', 'browser.query', { selector: '[data-rate]' }),
      body => {
        const rate = findQueryAttribute(body.messages, 'data-rate');
        if (!rate) throw new Error('The DOM query did not expose the data-rate attribute.');
        return toolReply('write-rate', 'fs.write', { path: 'fallback.txt', content: `USD exchange rate: ${rate}` });
      },
      textReply('done', 'I inspected the page data and saved the exchange rate to fallback.txt.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'browser-query-fallback',
      userMessage: `Go to ${url}, extract the USD exchange rate hidden in the page data and save it to fallback.txt.`,
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/fallback.txt')).toBe('USD exchange rate: 133.20');
    expect(tools.invocations.find(invocation => invocation.tool === 'browser.query')?.result.ok).toBe(true);
    expect(result.run.state?.durableActions?.find(action => action.tool === 'browser.query')?.receipt)
      .toMatchObject({ tool: 'browser.query', ok: true });
  });

  it('accepts a model-authored summary after verifying page evidence, write, and open effects', async () => {
    const url = 'https://fixture.example.test/briefing';
    const guest = new MockGuestTransport({
      pages: {
        [url]: '<!doctype html><html><head><title>Market Briefing</title></head><body><main><h1>Market Briefing</h1><p>Trading opened higher after lower inflation. Energy stocks led gains while bond yields eased.</p></main></body></html>',
      },
    });
    const requests: CapturedRequest[] = [];
    const summary = 'Markets opened higher as inflation eased. Energy shares led the advance, and bond yields fell.';
    const { runtime, tools } = createRuntime(guest, [
      toolReply('navigate', 'browser.navigate', { url }),
      toolReply('read-briefing', 'browser.read', { query: 'market briefing' }),
      toolReply('write-summary', 'fs.write', { path: 'summary.txt', content: summary }),
      toolReply('open-summary', 'app.openFile', { path: 'summary.txt', application: 'text-editor' }),
      textReply('done', 'I summarized the briefing in summary.txt and opened it in the text editor.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'model-authored-summary',
      userMessage: `Go to ${url}, summarize the page, save the summary to summary.txt and open the file.`,
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/summary.txt')).toBe(summary);
    expect(guest.getFile('/home/helm/workspace/summary.txt')?.length).toBeGreaterThan(0);
    expect(result.run.state?.durableActions?.some(action => action.tool === 'browser.read' && action.result.ok)).toBe(true);
    expect(result.run.state?.durableActions?.find(action => action.tool === 'fs.write')?.receipt)
      .toMatchObject({ tool: 'fs.write', ok: true });
    expect(result.run.state?.durableActions?.find(action => action.tool === 'app.openFile')?.receipt)
      .toMatchObject({ tool: 'app.openFile', ok: true });
    expect(guest.desktopWindows).toContainEqual(expect.objectContaining({
      application: 'text-editor',
      title: expect.stringContaining('summary.txt'),
    }));
    expect(requests.length).toBeGreaterThan(0);
    expect(tools.invocations.some(invocation => invocation.tool === 'browser.read')).toBe(true);
  });
});
