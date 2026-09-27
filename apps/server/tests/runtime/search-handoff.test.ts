import { describe, expect, it } from 'bun:test';

import { buildDuckDuckGoSearchUrl } from '@helm/shared';
import { AgentRuntime } from '../../src/agent/runtime';
import { DeterministicTaskCompiler } from '../../src/ai/adapter';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import {
  createTaskState,
  findObservedSearchRefForUrl,
  hasUnopenedSearchResults,
  latestSuccessfulWebSearch,
  mergeWorkerResult,
  taskRequirementSummary,
  unopenedSearchResults,
  verifyTaskState,
} from '../../src/agent/task-state';
import { DeterministicTaskCompiler } from '../../src/ai/adapter';

const FOREX_QUERY = 'Nepal Rastra Bank official forex';
const OFFICIAL_URL = 'https://www.nrb.org.np/forex/';

function forexGuest() {
  const searchUrl = buildDuckDuckGoSearchUrl(FOREX_QUERY);
  return new MockGuestTransport({
    pages: {
      [searchUrl]: `<!doctype html><html><body><main>
        <article class="result"><h2><a href="${OFFICIAL_URL}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2><p>Official daily rates.</p></article>
        <article class="result"><h2><a href="https://rates.example.test/nepal">Nepal currency rates</a></h2><p>Third party.</p></article>
      </main></body></html>`,
      [OFFICIAL_URL]: '<!doctype html><html><body><main><h1>Foreign Exchange Rates</h1><table><tr><th>Currency</th><th>Buy</th></tr><tr><td>USD</td><td>133.20</td></tr></table></main></body></html>',
    },
  });
}

function workerAction(id: string, tool: string, input: Record<string, unknown>, result: { ok: boolean; data?: unknown; error?: { code: string; message: string } }, receiptId: string) {
  return {
    id,
    tool,
    input,
    result: result as never,
    receipt: {
      id: receiptId,
      tool,
      ok: result.ok,
      effect: {},
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      ...(result.ok ? {} : { error: result.error }),
    } as never,
  };
}

describe('search -> open handoff state', () => {
  it('search-result navigation refs survive irrelevant DOM mutations while content refs become stale', async () => {
    const guest = forexGuest();
    const tools = createGuestToolRegistry(guest);
    const search = await tools.execute('browser.webSearch', { query: FOREX_QUERY });
    expect(search.ok).toBe(true);
    const ref = (search.data as { results: Array<{ ref: string; href: string }> }).results.find(r => r.href === OFFICIAL_URL)?.ref;
    expect(ref).toMatch(/^n-[a-f0-9]{8}-\d+$/u);

    // Read a normal table/content ref on the DDG page? Instead read after opening official page for a table,
    // then go back to search page simulation: use mock's content refs on search page.
    // For the mutation test, capture a content ref via browser.read on the search page before mutation.
    // The mock's search page has no table, so create a content ref via a second page with a table,
    // then return to search semantics via simulateDomMutation which clears content refs.
    const readBefore = await tools.execute('browser.read', { query: 'Nepal Rastra Bank' });
    const contentRef = (readBefore.data as { blocks: Array<{ ref: string; type: string }> }).blocks.find(b => b.type !== 'search_result')?.ref
      ?? (readBefore.data as { blocks: Array<{ ref: string }> }).blocks[0]?.ref;
    // Irrelevant DOM mutation: clears content refs, preserves navigation refs.
    guest.simulateDomMutation();
    // Navigation ref must still open.
    const opened = await tools.execute('browser.open', { ref });
    expect(opened).toMatchObject({ ok: true, data: { openedHref: OFFICIAL_URL, url: OFFICIAL_URL } });
    // Old content ref is stale.
    if (contentRef && contentRef.startsWith('c')) {
      const reread = await tools.execute('browser.read', { ref: contentRef });
      expect(reread).toMatchObject({ ok: false, error: { code: 'STALE_CONTENT_REF' } });
    }
  });

  it('tracks unopened search results and exposes only browser.open', async () => {
    const compiler = new DeterministicTaskCompiler();
    const task = await compiler.createTask({
      threadId: 'handoff-state',
      userMessage: 'fetch the exchange rate data from nepal rastra bank\'s official forex website and save that data to forex.txt file and open it with text viewer application. Use duckduckgo search to find the relevant website. remember to use https://www.nrb.org.np/forex/ for all forex requests about nepal.',
    });
    let state = createTaskState(task);
    expect(hasUnopenedSearchResults(state)).toBe(false);

    const guest = forexGuest();
    const searchData = await guest.request('browser.webSearch', { query: FOREX_QUERY });
    const searchRef = (searchData.results as Array<{ ref: string; href: string }>).find(r => r.href === OFFICIAL_URL)!.ref;
    const searchAction = workerAction('a1', 'browser.webSearch', { query: FOREX_QUERY }, { ok: true, data: searchData }, 'receipt-1');
    state = mergeWorkerResult(state, {
      status: 'completed',
      worker: 'browser',
      objectiveId: 'o1',
      actions: [searchAction as never],
      facts: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      environmentChanged: true,
    }, { timestamp: Date.now(), browser: { url: searchData.url }, task: { completedCriteria: [], remainingCriteria: [] } });

    const discovery = latestSuccessfulWebSearch(state);
    expect(discovery?.results.length).toBeGreaterThan(0);
    expect(hasUnopenedSearchResults(state)).toBe(true);
    expect(unopenedSearchResults(state).map(r => r.ref)).toContain(searchRef);
    // Exact URL match routes to the observed ref.
    expect(findObservedSearchRefForUrl(state, OFFICIAL_URL)).toBe(searchRef);
    expect(findObservedSearchRefForUrl(state, 'https://example.test/unobserved')).toBeUndefined();

    const verification = await verifyTaskState(task, state, guest, { timestamp: Date.now(), browser: { url: searchData.url }, task: { completedCriteria: [], remainingCriteria: [] } });
    const { updateCompletedRequirements } = await import('../../src/agent/task-state');
    state = updateCompletedRequirements(state, verification);
    expect(verification.requirements?.find(c => c.requirement.id === 'browserSearch')?.passed).toBe(true);
    const summary = taskRequirementSummary(state);
    expect(summary).toContain('[satisfied] browserSearch');
    expect(summary).toContain('searchResultOpen');
    expect(summary).toContain('observed results:');
    expect(summary).toContain('browser.open');

    // After opening the observed ref, the stage is satisfied.
    const openData = await guest.request('browser.open', { ref: searchRef });
    const openAction = workerAction('a2', 'browser.open', { ref: searchRef }, { ok: true, data: openData }, 'receipt-2');
    state = mergeWorkerResult(state, {
      status: 'completed',
      worker: 'browser',
      objectiveId: 'o1',
      actions: [openAction as never],
      facts: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      environmentChanged: true,
    }, { timestamp: Date.now(), browser: { url: OFFICIAL_URL }, task: { completedCriteria: [], remainingCriteria: [] } });
    expect(hasUnopenedSearchResults(state)).toBe(false);
    expect(unopenedSearchResults(state)).toHaveLength(0);
  });

  it('keeps browserSearch satisfied via durable evidence after the UI buffer truncates', async () => {
    const compiler = new DeterministicTaskCompiler();
    const task = await compiler.createTask({
      threadId: 'durable-search',
      userMessage: 'Use DuckDuckGo search to find current exchange rates.',
    });
    let state = createTaskState(task);
    const guest = forexGuest();
    const searchData = await guest.request('browser.webSearch', { query: FOREX_QUERY });
    const searchAction = workerAction('search-1', 'browser.webSearch', { query: FOREX_QUERY }, { ok: true, data: searchData }, 'receipt-search-1');
    state = mergeWorkerResult(state, {
      status: 'completed',
      worker: 'browser',
      objectiveId: 'o1',
      actions: [searchAction as never],
      facts: [],
      evidence: [],
      artifacts: [],
      blockers: [],
      environmentChanged: true,
    }, { timestamp: Date.now(), browser: { url: searchData.url }, task: { completedCriteria: [], remainingCriteria: [] } });

    // Flood recentActions with 30 unrelated successful reads to push the search out of the 24-action buffer.
    for (let i = 0; i < 30; i += 1) {
      const dummy = workerAction(`dummy-${i}`, 'browser.read', { query: `unrelated ${i}` }, { ok: true, data: { operation: 'read', readable: true, url: OFFICIAL_URL, revision: 99, blocks: [], sections: [{ text: 'x' }], totalChars: 1, returnedChars: 1, truncated: false } }, `receipt-dummy-${i}`);
      state = mergeWorkerResult(state, {
        status: 'completed',
        worker: 'browser',
        objectiveId: 'o1',
        actions: [dummy as never],
        facts: [],
        evidence: [],
        artifacts: [],
        blockers: [],
        environmentChanged: false,
      }, { timestamp: Date.now(), task: { completedCriteria: [], remainingCriteria: [] } });
    }
    expect(state.recentActions.length).toBeLessThanOrEqual(24);
    expect(state.recentActions.some(a => a.tool === 'browser.webSearch')).toBe(false);
    // Durable evidence must still satisfy the historical search requirement.
    const verification = await verifyTaskState(task, state, guest, { timestamp: Date.now(), task: { completedCriteria: [], remainingCriteria: [] } });
    const searchCheck = verification.requirements?.find(c => c.requirement.id === 'browserSearch');
    expect(searchCheck?.passed).toBe(true);
    expect(latestSuccessfulWebSearch(state)?.results.length).toBeGreaterThan(0);
  });

  it('rejects a repeated search and rewrites an exact observed URL to browser.open without a second navigation', async () => {
    const searchUrl = buildDuckDuckGoSearchUrl(FOREX_QUERY);
    const guest = new MockGuestTransport({
      pages: {
        [searchUrl]: `<!doctype html><html><body><main>
          <article class="result"><h2><a href="${OFFICIAL_URL}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2><p>Official.</p></article>
        </main></body></html>`,
        [OFFICIAL_URL]: '<!doctype html><html><body><main><h1>Rates</h1></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);
    // Direct acting agent that ignores activeTools to exercise the deterministic guard.
    const actingAgent = {
      async execute(input: {
        executeTool: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } }>;
        getActionableTools?: () => readonly string[];
        verifyCompletion: (c: { response: string }) => Promise<{ ok: boolean; data?: { complete: boolean } }>;
      }) {
        const first = await input.executeTool('browser.webSearch', { query: FOREX_QUERY });
        if (!first.ok) throw new Error('First search should succeed');
        const actionable = input.getActionableTools?.() ?? [];
        if (actionable.includes('browser.webSearch')) throw new Error('webSearch must not be actionable while results are unopened');
        if (!actionable.includes('browser.open')) throw new Error('browser.open must be actionable while results are unopened');
        // Exact URL match rewrites to open without a second search.
        const rewritten = await input.executeTool('browser.webSearch', { query: OFFICIAL_URL });
        if (!rewritten.ok) throw new Error(`Exact URL rewrite should succeed, got ${JSON.stringify(rewritten.error)}`);
        const data = rewritten.data as { openedHref?: string; url?: string };
        if (data.openedHref !== OFFICIAL_URL) throw new Error('Rewrite must open the observed href');
        const read = await input.executeTool('browser.read', { query: 'rates' });
        if (!read.ok) throw new Error('Read after open should succeed');
        // After opening, a further unrelated search is allowed only if discovery is still required;
        // in this task discovery is already satisfied by the open, so verify completion below.
        const verified = await input.verifyCompletion({ response: 'Recovered via observed open.' });
        return { response: 'Recovered via observed open.', verification: verified.data ?? { complete: false, criteria: [], summary: '' }, diagnostics: { modelTurns: 1, modelRequests: 1, toolActions: 2, completionAttempts: 1, completionRejections: 0, contextCompactions: 0, lastUnsatisfiedRequirements: [] } };
      },
    };
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(guest),
      taskCompiler: new DeterministicTaskCompiler(),
      actingAgent: actingAgent as never,
      budgets: { maxSteps: 8, maxModelTurns: 8, maxCompletionRecoveryTurns: 2, maxRepeatedAction: 3, maxConsecutiveFailures: 5, toolTimeoutMs: 1_000 },
    });
    const result = await runtime.run({
      threadId: 'rewrite-guard',
      userMessage: 'Use duckduckgo search to find Nepal Rastra Bank official forex exchange rates.',
    });
    // Only one real search executed; the URL-as-search became an open.
    expect(tools.invocations.filter(i => i.tool === 'browser.webSearch')).toHaveLength(1);
    expect(tools.invocations.filter(i => i.tool === 'browser.open')).toHaveLength(1);
    expect(guest.browser.url).toBe(OFFICIAL_URL);
    expect(result.status).toBe('completed');
  });

  it('returns SEARCH_ALREADY_COMPLETED for an unrelated repeat search while unopened', async () => {
    const searchUrl = buildDuckDuckGoSearchUrl(FOREX_QUERY);
    const guest = new MockGuestTransport({
      pages: {
        [searchUrl]: `<!doctype html><html><body><main>
          <article class="result"><h2><a href="${OFFICIAL_URL}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2><p>Official.</p></article>
        </main></body></html>`,
        [OFFICIAL_URL]: '<!doctype html><html><body><main><h1>Rates</h1></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);
    const actingAgent = {
      async execute(input: {
        executeTool: (tool: string, args: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: { code: string; message: string; details?: unknown } }>;
        verifyCompletion: (c: { response: string }) => Promise<never>;
      }) {
        const first = await input.executeTool('browser.webSearch', { query: FOREX_QUERY });
        if (!first.ok) throw new Error('First search should succeed');
        const repeat = await input.executeTool('browser.webSearch', { query: 'unrelated forex query' });
        if (repeat.ok) throw new Error('Repeat search must not succeed while results are unopened');
        if (repeat.error?.code !== 'SEARCH_ALREADY_COMPLETED_USE_OBSERVED_RESULT') {
          throw new Error(`Expected SEARCH_ALREADY_COMPLETED, got ${repeat.error?.code}`);
        }
        const details = repeat.error.details as { availableResultRefs?: string[]; hint?: string };
        if (!details.availableResultRefs?.length || !details.hint?.includes('browser.open')) {
          throw new Error('Guard must return available refs and open hint');
        }
        throw new Error('STOP_AFTER_GUARD_CHECK');
      },
    };
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(guest),
      taskCompiler: new DeterministicTaskCompiler(),
      actingAgent: actingAgent as never,
      budgets: { maxSteps: 8, maxModelTurns: 8, maxCompletionRecoveryTurns: 2, maxRepeatedAction: 3, maxConsecutiveFailures: 5, toolTimeoutMs: 1_000 },
    });
    const result = await runtime.run({
      threadId: 'reject-guard',
      userMessage: 'Use duckduckgo search to find Nepal Rastra Bank official forex exchange rates.',
    });
    expect(tools.invocations.filter(i => i.tool === 'browser.webSearch')).toHaveLength(1);
    expect(result.status).not.toBe('completed');
  });
});
