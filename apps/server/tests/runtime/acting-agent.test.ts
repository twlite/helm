import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';

import { AgentRuntime } from '../../src/agent/runtime';
import { AiSdkActingAgent } from '../../src/ai/acting-agent';
import { DeterministicTaskCompiler } from '../../src/ai/adapter';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
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

type CapturedRequest = { body: Record<string, unknown>; reply?: ChatReply; status?: number };
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

function findDocumentRef(value: unknown): string | undefined {
  if (typeof value === 'string') {
    try { return findDocumentRef(JSON.parse(value) as unknown); } catch { return undefined; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const ref = findDocumentRef(item);
      if (ref) return ref;
    }
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.documentRef === 'string') return record.documentRef;
  for (const child of Object.values(record)) {
    const ref = findDocumentRef(child);
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

function createRuntime(
  guest: MockGuestTransport,
  replies: ScriptedReply[],
  requests: CapturedRequest[],
  memory?: MemoryService,
  maxModelTurns = 12,
  strictToolSchemas = false,
) {
  const provider = createOpenAICompatible({
    name: 'acting-agent-test',
    baseURL: 'http://localhost:1234/v1',
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body = JSON.parse(await request.text()) as Record<string, unknown>;
      if (strictToolSchemas) {
        const tools = Array.isArray(body.tools) ? body.tools : [];
        const unsupported = tools.flatMap((candidate, index) => {
          const tool = candidate as Record<string, unknown>;
          const definition = tool.function as Record<string, unknown> | undefined;
          const parameters = definition?.parameters as Record<string, unknown> | undefined;
          const reasons = [
            parameters?.type !== 'object' ? 'parameters.type must be object' : undefined,
            parameters?.anyOf !== undefined ? 'root anyOf is unsupported' : undefined,
            parameters?.oneOf !== undefined ? 'root oneOf is unsupported' : undefined,
            parameters?.allOf !== undefined ? 'root allOf is unsupported' : undefined,
            parameters?.not !== undefined ? 'root not is unsupported' : undefined,
            parameters?.$ref !== undefined ? 'root $ref is unsupported' : undefined,
          ].filter((reason): reason is string => reason !== undefined);
          return reasons.length > 0
            ? [{ index, name: definition?.name, reasons }]
            : [];
        });
        if (unsupported.length > 0) {
          requests.push({ body, status: 400 });
          return Response.json({
            error: {
              message: 'Invalid tool parameters JSON Schema.',
              type: 'invalid_request_error',
              param: 'tools',
              details: unsupported,
            },
          }, { status: 400 });
        }
      }
      const scripted = replies.shift();
      if (!scripted) throw new Error('The test model has no scripted reply remaining.');
      const reply = typeof scripted === 'function' ? scripted(body) : scripted;
      requests.push({ body, reply, status: 200 });
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
      maxModelTurns,
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
      toolReply('extract', 'browser.read', { mode: 'document', query: 'exchange rate table' }),
      body => {
        const sourceRef = findDocumentRef(body.messages);
        if (!sourceRef) throw new Error('The extracted document export ref was not returned to the model.');
        return toolReply('write', 'fs.writeFromRef', { path: 'forex.txt', sourceRef, format: 'text' });
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
    const write = actions.find(action => action.tool === 'fs.writeFromRef');
    const open = actions.find(action => action.tool === 'app.openFile');
    expect(write?.result.ok).toBe(true);
    expect(write?.receipt).toMatchObject({ tool: 'fs.write', ok: true });
    expect(open?.result.ok).toBe(true);
    expect(open?.receipt).toMatchObject({ tool: 'app.openFile', ok: true });
    expect(guest.desktopWindows).toContainEqual(expect.objectContaining({
      application: 'text-editor',
      title: expect.stringContaining('forex.txt'),
    }));
    const writeInput = tools.invocations.find(invocation => invocation.tool === 'fs.writeFromRef')?.input as Record<string, unknown>;
    expect(writeInput).toMatchObject({ path: 'forex.txt', sourceRef: expect.stringMatching(/^d\d+-/u), format: 'text' });
    expect(writeInput).not.toHaveProperty('content');
    expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
      'browserVisited1', 'browserEvidence', 'outputFile', 'openFile',
    ]));
    expect(result.run.diagnostics?.modelTurns).toBe(4);
    expect(result.run.diagnostics?.finalizationTurns).toBe(1);
    expect(requests.at(-1)?.body.tool_choice).toBeUndefined();
    expect(result.run.diagnostics?.modelRequestOutcomes?.at(-1)?.kind).toBe('finalization');
    expect(JSON.stringify(requests[0]?.body)).toContain('fs.writeFromRef only with browser.read.export.sourceRef');
    expect(JSON.stringify(requests[0]?.body)).toContain('Use app.launch only when the user asks to start an application without a file');
    expect(JSON.stringify(requests[0]?.body)).toContain('Use app.openFile for an existing file');
    expect(result.run.diagnostics?.modelRequestOutcomes?.map(outcome => outcome.kind)).toEqual([
      'acting-turn', 'acting-turn', 'acting-turn', 'acting-turn', 'finalization',
    ]);
    expect(tools.invocations.some(invocation => invocation.tool === 'app.launch')).toBe(false);
  });

  it('exports both exchange tables after transient navigation failure and finalizes at the acting-turn boundary', async () => {
    const url = 'https://fixture.example.test/forex';
    const fixture = await readFile(new URL('../../../../guest/helm-guest/tests/fixtures/forex-two-tables.html', import.meta.url), 'utf8');
    const guest = new MockGuestTransport({
      pages: { [url]: fixture },
      navigationFailuresAfterReach: { [url]: 'net::ERR_EMPTY_RESPONSE' },
    });
    const persistence = testDatabase();
    try {
      const requests: CapturedRequest[] = [];
      const memory = new MemoryService(persistence.sqlite);
      const { runtime, tools } = createRuntime(guest, [
        toolReply('navigate', 'browser.navigate', { url }),
        toolReply('read-document', 'browser.read', { mode: 'document', query: 'exchange rate data', maxChars: 300 }),
        body => {
          const documentRef = findDocumentRef(body.messages);
          if (!documentRef) throw new Error('The complete multi-table read did not return a documentRef.');
        return toolReply('write-complete-document', 'fs.writeFromRef', { path: 'forex.txt', sourceRef: documentRef, format: 'text' });
        },
        toolReply('open-rates', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
        toolReply('remember-source', 'memory.remember', {
          content: `Use ${url} for forex requests about Nepal.`,
          kind: 'instruction',
          source: 'user',
        }),
        textReply('done', 'I saved the exchange rates to forex.txt, opened it in the text viewer, and remembered the source.'),
      ], requests, memory, 5, true);

      const result = await runtime.run({
        threadId: 'dynamic-table-full-effect-scenario',
        userMessage: `Fetch the exchange rate data from the official forex website at ${url}, save it to forex.txt and open it with the text viewer. Remember to use that site for all forex requests about Nepal in the future.`,
      });

      expect(result.status).toBe('completed');
      expect(result.run.task?.requirements?.find(requirement => requirement.id === 'outputFile')).toMatchObject({
        target: { mode: 'written-from-artifact', sourceUrls: [url] },
      });
      const saved = guest.getFile('/home/helm/workspace/forex.txt') ?? '';
      for (const currency of ['Indian Rupee (INR)', 'US Dollar (USD)', 'Euro (EUR)', 'British Pound (GBP)', 'Japanese Yen (JPY)']) {
        expect(saved).toContain(currency);
      }
      expect(saved).not.toContain('Board of Directors');
      expect(saved).not.toContain('About NRB');
      expect(saved.length).toBeGreaterThan(0);
      const actions = [
        ...(result.run.state?.durableActions ?? []),
        ...(result.run.state?.recentActions ?? []),
      ];
      expect(actions.find(action => action.tool === 'browser.navigate')).toMatchObject({
        result: { ok: false, error: { code: 'BROWSER_NAVIGATION_FAILED' } },
      });
      expect(actions.filter(action => action.tool === 'browser.navigate')).toHaveLength(1);
      expect(actions.find(action => action.tool === 'browser.read')?.result).toMatchObject({
        ok: true,
        data: {
          url,
          diagnostics: {
            tableCount: 2,
            documentTableCount: 2,
            documentStructuredBlockCount: 2,
            selectedBlockCount: expect.any(Number),
          },
          documentRef: expect.stringMatching(/^d\d+-/u),
        },
      });
      expect(actions.find(action => action.tool === 'fs.writeFromRef')?.result).toMatchObject({
        ok: true,
        data: { sourceType: 'document', sourceRefs: expect.arrayContaining([expect.stringMatching(/^c\d+-/u), expect.stringMatching(/^c\d+-/u)]) },
      });
      expect(actions.find(action => action.tool === 'memory.remember')).toMatchObject({
        result: { ok: true, data: { action: 'remembered' } },
        receipt: { tool: 'memory.remember', ok: true, effect: { changed: true } },
      });
      expect(actions.find(action => action.tool === 'fs.writeFromRef')?.receipt).toMatchObject({
        tool: 'fs.write', ok: true, effect: { path: '/home/helm/workspace/forex.txt', writePerformed: true },
      });
      expect(actions.find(action => action.tool === 'app.openFile')?.receipt).toMatchObject({
        tool: 'app.openFile', ok: true,
        effect: { path: '/home/helm/workspace/forex.txt', application: 'text-editor' },
      });
      expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
        'browserVisited1', 'browserEvidence', 'memoryMutation', 'outputFile', 'openFile',
      ]));
      expect(result.run.diagnostics?.lastUnsatisfiedRequirements).toEqual([]);
      expect(tools.invocations.some(invocation => invocation.tool === 'app.launch')).toBe(false);
      expect(guest.desktopWindows).toContainEqual(expect.objectContaining({
        application: 'text-editor',
        title: expect.stringContaining('forex.txt'),
      }));
      expect(result.run.diagnostics?.modelTurns).toBe(5);
      expect(result.run.diagnostics?.finalizationTurns).toBe(1);
      expect(result.run.diagnostics?.toolActions).toBe(5);
      expect(result.run.diagnostics?.modelRequestOutcomes).toHaveLength(6);
      expect(result.run.diagnostics?.modelRequestOutcomes?.map(outcome => outcome.kind)).toEqual([
        'acting-turn', 'acting-turn', 'acting-turn', 'acting-turn', 'acting-turn', 'finalization',
      ]);
      expect(result.run.diagnostics?.modelRequestOutcomes?.some(outcome => outcome.errorCode === 'MODEL_TURN_BUDGET_EXCEEDED')).toBe(false);
      expect(requests[4]?.body.tool_choice).toBe('auto');
      expect(requests[5]?.body.tools).toBeUndefined();
      expect(requests.every(request => request.status === 200)).toBe(true);
      const firstRequestTools = requests[0]?.body.tools as Array<Record<string, unknown>>;
      expect(firstRequestTools.length).toBeGreaterThan(29);
      expect(new TextEncoder().encode(JSON.stringify(firstRequestTools)).length).toBeLessThan(50_000);
      const toolByName = new Map<string, Record<string, unknown>>();
      for (const item of firstRequestTools) {
        expect(item.type).toBe('function');
        const definition = item.function as Record<string, unknown>;
        expect(definition).toBeDefined();
        expect(typeof definition.name).toBe('string');
        expect(definition.parameters).toBeDefined();
        expect(typeof definition.description).toBe('string');
        expect((definition.description as string).length).toBeLessThan(2_000);
        toolByName.set(definition.name as string, definition);
      }
      expect(toolByName.has('memory.remember')).toBe(true);
      for (const [name, definition] of toolByName) {
        const parameters = definition.parameters as Record<string, unknown>;
        expect(parameters.type, `${name} parameters.type`).toBe('object');
        expect(parameters.anyOf, `${name} root anyOf`).toBeUndefined();
        expect(parameters.oneOf, `${name} root oneOf`).toBeUndefined();
        expect(parameters.allOf, `${name} root allOf`).toBeUndefined();
        expect(parameters.not, `${name} root not`).toBeUndefined();
        expect(parameters.$ref, `${name} root $ref`).toBeUndefined();
      }
      expect(toolByName.has('fs.write')).toBe(false);
      expect(Object.keys((toolByName.get('fs.writeText')?.parameters as Record<string, unknown>).properties as object).sort())
        .toEqual(['content', 'path']);
      expect(Object.keys((toolByName.get('fs.writeFromRef')?.parameters as Record<string, unknown>).properties as object).sort())
        .toEqual(['format', 'path', 'sourceRef']);
      expect(toolByName.get('fs.writeText')?.parameters).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({ path: expect.any(Object), content: expect.any(Object) }),
      });
      expect(toolByName.get('fs.writeFromRef')?.parameters).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({ path: expect.any(Object), sourceRef: expect.any(Object), format: expect.any(Object) }),
      });
      expect((toolByName.get('fs.writeText')?.parameters as Record<string, unknown>).anyOf).toBeUndefined();
      expect((toolByName.get('fs.writeFromRef')?.parameters as Record<string, unknown>).anyOf).toBeUndefined();
      expect(toolByName.get('browser.read')?.parameters).toMatchObject({
        type: 'object',
        properties: expect.objectContaining({ ref: expect.any(Object), mode: expect.any(Object), offset: expect.any(Object) }),
      });
      expect(result.run.diagnostics?.modelRequestOutcomes?.[0]).toMatchObject({ kind: 'acting-turn', outcome: 'tool-call' });
    } finally {
      persistence.close();
    }
  });

  it('recovers from a preview write by exposing the verified document ref and model-visible raw write tool', async () => {
    const url = 'https://fixture.example.test/forex';
    const fixture = await readFile(new URL('../../../../guest/helm-guest/tests/fixtures/forex-two-tables.html', import.meta.url), 'utf8');
    const guest = new MockGuestTransport({ pages: { [url]: fixture } });
    const persistence = testDatabase();
    try {
      const requests: CapturedRequest[] = [];
      const memory = new MemoryService(persistence.sqlite);
      let observedDocumentRef: string | undefined;
      let recoveryText = '';
      const { runtime, tools } = createRuntime(guest, [
        toolReply('navigate', 'browser.navigate', { url }),
        toolReply('read-document', 'browser.read', { mode: 'document', query: 'exchange rate data', maxChars: 300 }),
        body => {
          observedDocumentRef = findDocumentRef(body.messages);
          if (!observedDocumentRef) throw new Error('The read did not expose its durable document ref.');
          return toolReply('write-preview', 'fs.writeText', {
            path: 'forex.txt',
            content: 'Currency | Unit | Buy | Sell\nIndian Rupee (INR) | 100 | 160.00 | 160.15',
          });
        },
        toolReply('open-rates', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
        toolReply('remember-source', 'memory.remember', {
          content: `Use ${url} for forex requests about Nepal.`,
          kind: 'instruction',
          source: 'user',
        }),
        textReply('premature-done', 'Done!'),
        body => {
          recoveryText = JSON.stringify(body.messages);
          const sourceRef = findDocumentRef(body.messages);
          if (!sourceRef) throw new Error('Recovery omitted the current-run durable document ref.');
          return toolReply('write-from-document', 'fs.writeFromRef', {
            path: 'forex.txt', sourceRef, format: 'text',
          });
        },
        textReply('final', 'I saved the exchange-rate data, opened forex.txt, and remembered the source.'),
      ], requests, memory, 12, true);

      const result = await runtime.run({
        threadId: 'preview-write-provenance-recovery',
        userMessage: `Fetch the exchange rate data from the official forex website at ${url}, save that data to forex.txt and open it with the text viewer application. Remember to use that site for all forex requests about Nepal in the future.`,
      });

      expect(result.status).toBe('completed');
      expect(observedDocumentRef).toMatch(/^d\d+-/u);
      expect(recoveryText).toContain('outputFile');
      expect(recoveryText).toContain('BROWSER_PROVENANCE_REQUIRED');
      expect(recoveryText).toContain('fs.writeText');
      expect(recoveryText).toContain('fs.writeFromRef');
      expect(recoveryText).toContain(observedDocumentRef!);
      expect(recoveryText).toContain(url);
      expect(recoveryText).toContain('action=fs.writeFromRef');
      expect(recoveryText).not.toContain('action=fs.write ');
      expect(result.run.diagnostics?.completionRejections).toBeGreaterThanOrEqual(1);
      expect(result.run.diagnostics?.completionRejections).toBeLessThan(3);
      expect(result.run.diagnostics?.requirementRejections).toContainEqual(expect.objectContaining({
        requirementId: 'outputFile',
        reasonCode: 'BROWSER_PROVENANCE_REQUIRED',
        correctiveTool: 'fs.writeFromRef',
        rejectedAction: { tool: 'fs.writeText', path: 'forex.txt', receiptId: expect.any(String) },
        correctiveArtifact: expect.objectContaining({ sourceRef: observedDocumentRef, sourceType: 'document', sourceUrl: url, sourceTableCount: 2, complete: true }),
      }));
      expect(result.run.diagnostics?.modelRequestOutcomes?.some(outcome => outcome.errorCode === 'COMPLETION_RECOVERY_BUDGET_EXCEEDED')).toBe(false);

      const actions = [...(result.run.state?.durableActions ?? []), ...(result.run.state?.recentActions ?? [])];
      expect(actions.find(action => action.tool === 'browser.read')?.result).toMatchObject({
        ok: true,
        data: {
          previewsAreComplete: false,
          export: { complete: true, sourceRef: observedDocumentRef, recommendedTool: 'fs.writeFromRef' },
        },
      });
      expect(actions.some(action => action.tool === 'fs.writeText' && action.result.ok)).toBe(true);
      expect(actions.some(action => action.tool === 'fs.writeFromRef' && action.result.ok)).toBe(true);
      expect(actions.find(action => action.tool === 'fs.writeFromRef')).toMatchObject({
        result: { ok: true, data: { sourceRef: observedDocumentRef, sourceType: 'document', sourceUrl: url, sourceTableCount: 2, sourceTruncated: false } },
        receipt: { tool: 'fs.write', ok: true, effect: { path: '/home/helm/workspace/forex.txt', writePerformed: true } },
      });
      expect(result.run.state?.completedRequirementIds).toContain('outputFile');
      const saved = guest.getFile('/home/helm/workspace/forex.txt') ?? '';
      for (const currency of ['Indian Rupee (INR)', 'US Dollar (USD)', 'Euro (EUR)', 'British Pound (GBP)', 'Japanese Yen (JPY)']) {
        expect(saved).toContain(currency);
      }
      expect(tools.invocations.filter(invocation => invocation.tool === 'app.openFile')).toHaveLength(1);
      expect(tools.invocations.filter(invocation => invocation.tool === 'browser.navigate')).toHaveLength(1);
      expect(tools.invocations.find(invocation => invocation.tool === 'fs.writeFromRef')?.input).toMatchObject({
        path: 'forex.txt', sourceRef: observedDocumentRef, format: 'text',
      });
      expect(requests.every(request => request.status === 200)).toBe(true);
    } finally {
      persistence.close();
    }
  });

  it('recovers from a zero-match browser.read by reacquiring content before raw export', async () => {
    const url = 'https://fixture.example.test/forex';
    const fixture = await readFile(new URL('../../../../guest/helm-guest/tests/fixtures/forex-two-tables.html', import.meta.url), 'utf8');
    const guest = new MockGuestTransport({ pages: { [url]: fixture } });
    const persistence = testDatabase();
    try {
      const requests: CapturedRequest[] = [];
      const memory = new MemoryService(persistence.sqlite);
      let recoveryText = '';
      let recoveredDocumentRef: string | undefined;
      const { runtime, tools } = createRuntime(guest, [
        toolReply('navigate', 'browser.navigate', { url }),
        toolReply('filtered-read', 'browser.read', {
          mode: 'document', query: 'exchange rate data', blockTypes: ['text'],
        }),
        toolReply('placeholder-write', 'fs.writeText', {
          path: 'forex.txt',
          content: '[Data structure details omitted for brevity; full data is in the returned object]',
        }),
        toolReply('open-rates', 'app.openFile', { path: 'forex.txt', application: 'text-editor' }),
        toolReply('remember-source', 'memory.remember', {
          content: `Use ${url} for forex requests about Nepal.`, kind: 'instruction', source: 'user',
        }),
        textReply('premature-done', 'The data is saved and open.'),
        body => {
          recoveryText = JSON.stringify(body.messages);
          expect(recoveryText).toContain('NO_EXPORTABLE_BROWSER_ARTIFACT');
          expect(recoveryText).toContain('browser.read');
          expect(recoveryText).toContain('available block types: heading=1, navigation=1, table=2');
          expect(recoveryText).toContain('tableCount');
          expect(recoveryText).toContain('action=browser.read');
          expect(recoveryText).not.toContain('"correctiveTool":"fs.writeFromRef"');
          return toolReply('retry-read', 'browser.read', {
            mode: 'document', query: 'exchange rate data',
          });
        },
        body => {
          recoveredDocumentRef = findDocumentRef(body.messages);
          if (!recoveredDocumentRef) throw new Error('The successful retry did not expose its complete documentRef.');
          return toolReply('write-from-document', 'fs.writeFromRef', {
            path: 'forex.txt', sourceRef: recoveredDocumentRef, format: 'text',
          });
        },
        textReply('final', 'I saved the complete exchange-rate data, opened the file, and remembered the source.'),
      ], requests, memory, 12, true);

      const result = await runtime.run({
        threadId: 'zero-match-read-recovery',
        userMessage: `Fetch the exchange rate data from the official forex website at ${url}, save that data to forex.txt and open it with the text viewer application. Remember to use that site for all forex requests about Nepal in the future.`,
      });

      expect(result.status, JSON.stringify({ error: result.run.error, diagnostics: result.run.diagnostics, actions: result.run.state?.durableActions }, null, 2)).toBe('completed');
      expect(result.run.diagnostics?.completionRejections).toBeGreaterThanOrEqual(1);
      expect(result.run.diagnostics?.modelRequestOutcomes?.some(outcome => outcome.errorCode === 'COMPLETION_RECOVERY_BUDGET_EXCEEDED')).toBe(false);
      expect(result.run.diagnostics?.requirementRejections).toContainEqual(expect.objectContaining({
        requirementId: 'outputFile',
        reasonCode: 'NO_EXPORTABLE_BROWSER_ARTIFACT',
        correctiveTool: 'browser.read',
        message: expect.stringContaining('No complete current-run browser export artifact is available'),
        evidence: expect.objectContaining({
          exportAvailable: false,
          latestBrowserReadFailure: expect.objectContaining({
            requestedBlockTypes: ['text'],
            tableCount: 2,
            selectedBlockCount: 0,
            exportAvailable: false,
          }),
        }),
      }));

      const actions = [...(result.run.state?.durableActions ?? []), ...(result.run.state?.recentActions ?? [])];
      expect(actions.find(action => action.tool === 'browser.read' && !action.result.ok)).toMatchObject({
        result: { ok: false, error: {
          code: 'BROWSER_READ_NO_MATCHING_CONTENT',
          details: { requestedBlockTypes: ['text'], tableCount: 2, selectedBlockCount: 0, exportAvailable: false },
        } },
      });
      expect(actions.find(action => action.tool === 'browser.read' && action.result.ok)).toMatchObject({
        result: { ok: true, data: { export: { complete: true, sourceRef: recoveredDocumentRef }, diagnostics: { documentTableCount: 2 } } },
      });
      expect(actions.some(action => action.tool === 'fs.writeText' && action.result.ok)).toBe(true);
      expect(actions.some(action => action.tool === 'fs.writeFromRef' && action.result.ok)).toBe(true);
      expect(result.run.state?.completedRequirementIds).toContain('browserEvidence');
      expect(result.run.state?.completedRequirementIds).toContain('outputFile');
      const saved = guest.getFile('/home/helm/workspace/forex.txt') ?? '';
      for (const currency of ['Indian Rupee (INR)', 'US Dollar (USD)', 'Euro (EUR)', 'British Pound (GBP)', 'Japanese Yen (JPY)']) {
        expect(saved).toContain(currency);
      }
      expect(tools.invocations.filter(invocation => invocation.tool === 'browser.read')).toHaveLength(2);
      expect(tools.invocations.filter(invocation => invocation.tool === 'fs.writeFromRef')).toHaveLength(1);
      expect(requests.every(request => request.status === 200)).toBe(true);
    } finally {
      persistence.close();
    }
  });

  it('recovers from a real FILE_NOT_FOUND result when it tries opening before writing', async () => {
    const guest = new MockGuestTransport();
    const requests: CapturedRequest[] = [];
    const { runtime, tools } = createRuntime(guest, [
      toolReply('open-missing', 'app.openFile', { path: 'notes.txt', application: 'text-editor' }),
      toolReply('write-notes', 'fs.writeText', { path: 'notes.txt', content: 'Today I reviewed the project notes.' }),
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
        return toolReply('write-rate', 'fs.writeText', { path: 'fallback.txt', content: `USD exchange rate: ${rate}` });
      },
      textReply('done', 'I inspected the page data and saved the exchange rate to fallback.txt.'),
    ], requests);

    const result = await runtime.run({
      threadId: 'browser-query-fallback',
      userMessage: `Go to ${url}, inspect the USD exchange rate hidden in the page data, summarize that rate, and save the summary to fallback.txt.`,
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
      toolReply('write-summary', 'fs.writeText', { path: 'summary.txt', content: summary }),
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
    expect(result.run.state?.durableActions?.find(action => action.tool === 'fs.writeText')?.receipt)
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
