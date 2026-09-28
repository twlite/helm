import { describe, expect, it } from 'bun:test';

import { buildDuckDuckGoSearchUrl } from '@helm/shared';
import { AgentRuntime } from '../../src/agent/runtime';
import { DeterministicTaskCompiler } from '../../src/ai/adapter';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';

describe('model-directed browser search', () => {
  it('allows a refined second search after the first results are poor', async () => {
    const firstQuery = 'forex rate';
    const refinedQuery = 'Nepal Rastra Bank official forex';
    const firstSearchUrl = buildDuckDuckGoSearchUrl(firstQuery);
    const refinedSearchUrl = buildDuckDuckGoSearchUrl(refinedQuery);
    const guest = new MockGuestTransport({
      pages: {
        [firstSearchUrl]: '<!doctype html><html><body><main><article><h2><a href="https://irrelevant.example.test">Forex rate information</a></h2><p>Not the requested source.</p></article></main></body></html>',
        [refinedSearchUrl]: '<!doctype html><html><body><main><article><h2><a href="https://nrb.example.test/forex">Nepal Rastra Bank Forex</a></h2><p>Official exchange rates.</p></article></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);
    let searchResults = 0;
    const actingAgent = {
      async execute(input: {
        executeTool(tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string } }>;
        verifyCompletion(candidate: { response: string }): Promise<{ ok: boolean; data?: { complete: boolean; criteria: []; requirements: []; summary: string } }>;
      }) {
        const poor = await input.executeTool('browser.webSearch', { query: firstQuery });
        expect(poor.ok).toBe(true);
        searchResults = (poor.data as { results: unknown[] }).results.length;
        const refined = await input.executeTool('browser.webSearch', { query: refinedQuery });
        expect(refined.ok).toBe(true);
        expect((refined.data as { results: Array<{ href: string }> }).results[0]?.href).toBe('https://nrb.example.test/forex');
        const completion = await input.verifyCompletion({ response: 'I refined the search and found the official exchange-rate result.' });
        return {
          response: 'I refined the search and found the official exchange-rate result.',
          verification: completion.data,
          diagnostics: {
            modelTurns: 1,
            modelRequests: 1,
            toolActions: 2,
            completionAttempts: 1,
            completionRejections: 0,
            contextCompactions: 0,
            lastUnsatisfiedRequirements: [],
          },
        };
      },
    };
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(guest),
      taskCompiler: new DeterministicTaskCompiler(),
      actingAgent: actingAgent as never,
      budgets: { maxSteps: 8, maxModelTurns: 4, maxCompletionRecoveryTurns: 1, maxRepeatedAction: 3, maxConsecutiveFailures: 5, toolTimeoutMs: 1_000 },
    });

    const result = await runtime.run({
      threadId: 'refined-search',
      userMessage: 'Use DuckDuckGo search to find Nepal Rastra Bank official forex rates.',
    });

    expect(result.status).toBe('completed');
    expect(searchResults).toBeGreaterThan(0);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.webSearch')).toHaveLength(2);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.webSearch').every(invocation => invocation.result.ok)).toBe(true);
  });

  it('writes a returned content snapshot directly after mutation and later navigation', async () => {
    const sourceUrl = 'https://fixture.example.test/rates';
    const otherUrl = 'https://fixture.example.test/other';
    const guest = new MockGuestTransport({
      pages: {
        [sourceUrl]: '<!doctype html><html><body><main><table><tr><th>Currency</th><th>Buy</th></tr><tr><td>USD</td><td>133.20</td></tr></table></main></body></html>',
        [otherUrl]: '<!doctype html><html><body><main><h1>Another page</h1></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);
    await tools.execute('browser.navigate', { url: sourceUrl });
    const read = await tools.execute('browser.read', { query: 'currency table' });
    expect(read.ok).toBe(true);
    const table = (read.data as { blocks: Array<{ type: string; ref: string }> }).blocks.find(block => block.type === 'table');
    expect(table?.ref).toMatch(/^c\d+-/u);

    guest.simulateDomMutation();
    const afterMutation = await tools.execute('fs.write', { path: 'after-mutation.txt', sourceRef: table!.ref, format: 'text' });
    expect(afterMutation.ok).toBe(true);
    expect(guest.getFile('/home/helm/workspace/after-mutation.txt')).toContain('USD | 133.20');

    await tools.execute('browser.navigate', { url: otherUrl });
    const afterNavigation = await tools.execute('fs.write', { path: 'after-navigation.txt', sourceRef: table!.ref, format: 'text' });
    expect(afterNavigation.ok).toBe(true);
    expect(guest.getFile('/home/helm/workspace/after-navigation.txt')).toContain('USD | 133.20');
  });
});
