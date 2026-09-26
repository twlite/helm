import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import type { AgentDecision, Memory } from '@helm/shared';

import { AgentRuntime } from '../../src/agent/runtime';
import { browserResearchSearchUrl, browserResearchTask } from '../../src/agent/browser-research';
import { deriveBrowserReadQuery } from '@helm/shared';
import { LoopDetector } from '../../src/agent/fingerprint';
import { ScriptedDecisionProvider } from '../../src/agent/planner';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import {
  DEMO_PAGE_TEXT,
  DEMO_PAGE_URL,
  MockGuestTransport,
} from '../../src/tools/mock-guest-transport';
import { createScriptedDemo } from '../../src/agent/demo';
import { ToolRegistry } from '../../src/tools/tool-registry';

describe('AgentRuntime', () => {
  it('rejects browser downloads that use model-invented URLs', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const userMessage = 'Find the current foreign exchange rates.';
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: new ScriptedDecisionProvider([
        { type: 'action', tool: 'browser.download', input: { url: 'https://guessed.example.test/latest.csv' } },
        { type: 'blocked', reason: 'The runtime rejected an unobserved download URL.' },
      ]),
    });

    const result = await runtime.run({
      threadId: 'unobserved-download',
      userMessage,
      task: browserResearchTask({ threadId: 'unobserved-download', userMessage }),
    });

    expect(result.status).toBe('blocked');
    expect(result.steps.find(step => step.toolName === 'browser.download')?.toolResult?.error)
      .toMatchObject({ code: 'UNOBSERVED_DOWNLOAD_URL' });
    expect(tools.invocations.some(invocation => invocation.tool === 'browser.download')).toBe(false);
  });

  it('accepts only user, verified-memory, or observed-link destinations and searches DuckDuckGo otherwise', async () => {
    const runScenario = async (input: {
      userMessage: string;
      proposedUrl: string;
      memories?: Memory[];
      pages?: Record<string, string>;
      followLink?: string;
      retryNavigation?: string;
      redirects?: Record<string, string>;
      navigationFailures?: Record<string, string>;
    }) => {
      const genericContentPage = '<html><body><main><h1>Rates</h1><p>Exchange rate data content.</p></main></body></html>';
      const pages = {
        [input.proposedUrl]: genericContentPage,
        [browserResearchSearchUrl(deriveBrowserReadQuery(input.userMessage))]: genericContentPage,
        ...input.pages,
      };
      const guest = new MockGuestTransport({
        pages,
        ...(input.redirects ? { redirects: input.redirects } : {}),
        ...(input.navigationFailures ? { navigationFailures: input.navigationFailures } : {}),
      });
      const tools = createGuestToolRegistry(guest);
      const verifier = new CriterionVerifierRegistry(guest);
      const decisions: AgentDecision[] = [
        { type: 'action', tool: 'browser.navigate', input: { url: input.proposedUrl } },
        ...(input.retryNavigation ? [{ type: 'action' as const, tool: 'browser.navigate', input: { url: input.retryNavigation } }] : []),
        { type: 'action', tool: 'browser.read', input: { query: 'content' } },
        ...(input.followLink ? [
          { type: 'action' as const, tool: 'browser.navigate', input: { url: input.followLink } },
          { type: 'action' as const, tool: 'browser.read', input: { query: 'content' } },
        ] : []),
        { type: 'complete' },
      ];
      const seenProvenance = new Set<string>();
      let decisionIndex = 0;
      const runtime = new AgentRuntime({
        guestTransport: guest,
        toolRegistry: tools,
        verifier,
        memories: input.memories,
        decisionProvider: {
          next: async context => {
            for (const previous of context.previousResults) {
              const data = previous.data;
              if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
                const provenance = (data as Record<string, unknown>).urlProvenance;
                if (typeof provenance === 'string') seenProvenance.add(provenance);
              }
            }
            return decisions[decisionIndex++] ?? { type: 'complete' };
          },
        },
      });
      const result = await runtime.run({
        threadId: 'url-provenance',
        userMessage: input.userMessage,
        task: browserResearchTask({ threadId: 'url-provenance', userMessage: input.userMessage }),
      });
      return {
        result,
        navigations: tools.invocations.filter(invocation => invocation.tool === 'browser.navigate'),
        seenProvenance,
      };
    };

    const explicitUrl = 'https://bank.example.test/rates';
    const explicit = await runScenario({
      userMessage: `Open ${explicitUrl} and read the rates.`,
      proposedUrl: explicitUrl,
    });
    expect(explicit.result.status).toBe('completed');
    expect(explicit.navigations[0]?.input).toEqual({ url: explicitUrl });
    expect(explicit.seenProvenance).toContain('user');

    const savedUrl = 'https://bank.example.test/forex';
    const verifiedMemory: Memory = {
      id: 'saved-forex-source',
      content: 'Example Bank forex source.',
      kind: 'note',
      importance: 0.8,
      metadata: {},
      source: 'observed',
      sourceUrl: savedUrl,
      evidenceIds: ['receipt-forex-source'],
      lastVerifiedAt: '2026-09-25T12:00:00.000Z',
      createdAt: '2026-09-25T12:00:00.000Z',
      updatedAt: '2026-09-25T12:00:00.000Z',
    };
    const saved = await runScenario({
      userMessage: 'Find current forex rates using my saved source.',
      proposedUrl: savedUrl,
      memories: [verifiedMemory],
    });
    expect(saved.result.status).toBe('completed');
    expect(saved.navigations[0]?.input).toEqual({ url: savedUrl });
    expect(saved.seenProvenance).toContain('verified-memory');

    const unverifiedMemoryUrl = 'https://unverified.example.test/forex';
    const unverifiedMemory: Memory = {
      id: 'unverified-forex-source',
      content: 'Example Bank forex source.',
      kind: 'note',
      importance: 0.8,
      metadata: {},
      source: 'manual',
      sourceUrl: unverifiedMemoryUrl,
      evidenceIds: [],
      createdAt: '2026-09-25T12:00:00.000Z',
      updatedAt: '2026-09-25T12:00:00.000Z',
    };
    const unverified = await runScenario({
      userMessage: 'Find forex rates using my saved source.',
      proposedUrl: unverifiedMemoryUrl,
      memories: [unverifiedMemory],
    });
    expect(unverified.navigations[0]?.input).toEqual({
      url: browserResearchSearchUrl(deriveBrowserReadQuery('Find forex rates using my saved source.')),
    });
    expect(unverified.seenProvenance).toContain('duckduckgo-search');

    const request = 'Find Example Bank current forex rates.';
    const guessed = await runScenario({
      userMessage: request,
      proposedUrl: 'https://examplebank.test/forex',
    });
    const expectedSearchUrl = browserResearchSearchUrl(deriveBrowserReadQuery(request));
    expect(guessed.result.status).toBe('completed');
    expect(guessed.navigations[0]?.input).toEqual({ url: expectedSearchUrl });
    expect(guessed.seenProvenance).toContain('duckduckgo-search');

    const vagueMemory: Memory = {
      id: 'vague-forex-source',
      content: 'For forex rates, use Example Bank.',
      kind: 'preference',
      importance: 0.8,
      metadata: {},
      source: 'manual',
      createdAt: '2026-09-25T12:00:00.000Z',
      updatedAt: '2026-09-25T12:00:00.000Z',
    };
    const recalledName = await runScenario({
      userMessage: 'Find forex rates using the bank I mentioned earlier.',
      proposedUrl: 'https://examplebank.test/forex',
      memories: [vagueMemory],
    });
    expect(recalledName.result.status).toBe('completed');
    expect(recalledName.navigations[0]?.input).toEqual({
      url: browserResearchSearchUrl(deriveBrowserReadQuery('Find forex rates using the bank I mentioned earlier.')),
    });
    expect(recalledName.seenProvenance).toContain('duckduckgo-search');

    const failedMemory = await runScenario({
      userMessage: 'Find current forex rates using my saved source.',
      proposedUrl: savedUrl,
      retryNavigation: 'https://guessed.example.test/alternative',
      memories: [verifiedMemory],
      navigationFailures: { [savedUrl]: 'The saved page is unavailable.' },
    });
    expect(failedMemory.result.status).toBe('completed');
    expect(failedMemory.navigations.map(invocation => invocation.input)).toEqual([
      { url: savedUrl },
      { url: browserResearchSearchUrl(deriveBrowserReadQuery('Find current forex rates using my saved source.')) },
    ]);

    const redirectedUrl = 'https://bank.example.test/archive';
    const redirectedMemory = await runScenario({
      userMessage: 'Find current forex rates using my saved source.',
      proposedUrl: savedUrl,
      retryNavigation: 'https://guessed.example.test/alternative',
      memories: [verifiedMemory],
      redirects: { [savedUrl]: redirectedUrl },
      pages: { [redirectedUrl]: '<html><body><main><h1>Archived source</h1><p>Archived content.</p></main></body></html>' },
    });
    expect(redirectedMemory.result.status).toBe('completed');
    expect(redirectedMemory.navigations.map(invocation => invocation.input)).toEqual([
      { url: savedUrl },
      { url: browserResearchSearchUrl(deriveBrowserReadQuery('Find current forex rates using my saved source.')) },
    ]);

    const startUrl = 'https://source.example.test/start';
    const observedHref = 'https://docs.example.test/rates-guide';
    const followed = await runScenario({
      userMessage: `Open ${startUrl} and follow the rates guide link.`,
      proposedUrl: startUrl,
      followLink: observedHref,
      pages: {
        [startUrl]: `<html><body><main><h1>Rates</h1><p>The rates guide explains the source data content.</p><a href="${observedHref}">Rates guide</a></main></body></html>`,
        [observedHref]: '<html><body><main><h1>Rates guide</h1><p>Guide content.</p></main></body></html>',
      },
    });
    expect(followed.result.status).toBe('completed');
    expect(followed.navigations.map(invocation => invocation.input)).toEqual([
      { url: startUrl },
      { url: observedHref },
    ]);
    expect(followed.seenProvenance).toContain('page-link');
  });

  it('completes browser research after a bounded page read', async () => {
    const guest = new MockGuestTransport({ pages: { 'https://duckduckgo.com/?q=example': '<html><body><main><h1>Demo</h1><p>Helm deterministic demo content.</p></main></body></html>' } });
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: new ScriptedDecisionProvider([
        { type: 'action', tool: 'browser.navigate', input: { url: 'https://www.google.com/search?q=example' } },
        { type: 'action', tool: 'browser.read', input: { query: 'demo content' } },
        { type: 'complete' },
      ]),
    });

    const result = await runtime.run({
      userMessage: 'Find the demo content from the official site.',
      task: browserResearchTask({
        threadId: 'browser-research',
        userMessage: 'Find the demo content from the official site.',
      }),
      threadId: 'browser-research',
    });


    expect(result.status).toBe('completed');
    expect(tools.invocations.find(invocation => invocation.tool === 'browser.navigate')?.input).toEqual({
      url: 'https://duckduckgo.com/?q=example',
    });
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.read')).toBe(true);
    expect(result.finalVerification?.complete).toBe(true);
  });

  it('searches first, ranks a forex table, writes its full content ref, and opens the file', async () => {
    const userMessage = 'Fetch exchange rate data, save it in forex.txt, and open the file in the text viewer.';
    const searchUrl = browserResearchSearchUrl(deriveBrowserReadQuery(userMessage));
    const guessedUrl = 'https://rates.example.test/assumed-route';
    const resultUrl = 'https://rates.example.test/daily';
    const ratePage = `<html><body>
      <nav>Home Deposit Current Account Saving Account</nav>
      <h1>Foreign Exchange Rate</h1>
      <h2>Exchange Rate of 24-September-2026 10:00 AM</h2>
      <table><thead><tr><th>Currency</th><th>Code</th><th>Unit</th><th>Buying: Cash below Deno 50</th><th>Buying: Cash 50 and above Deno</th><th>Selling</th></tr></thead>
        <tbody>
          <tr><td>USD</td><td>USD</td><td>1</td><td>152.28</td><td>153.05</td><td>153.65</td></tr>
          <tr><td>Euro</td><td>EUR</td><td>1</td><td>173.65</td><td>173.65</td><td>175.36</td></tr>
          <tr><td>Japanese Yen</td><td>JPY</td><td>10</td><td>9.69</td><td>9.69</td><td>9.78</td></tr>
          <tr><td>Indian Currency</td><td>INR</td><td>100</td><td>160.00</td><td>160.00</td><td>160.15</td></tr>
        </tbody>
      </table>
      <footer>Footer links and unrelated banking information.</footer>
    </body></html>`;
    const guest = new MockGuestTransport({
      pages: {
        [searchUrl]: `<html><body><main><h1>Search results</h1><p>Foreign exchange rate data from the official bank.</p><a href="${resultUrl}">Daily exchange rate table</a></main></body></html>`,
        [resultUrl]: ratePage,
      },
    });
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    let decisionIndex = 0;
    const latestRead = (context: { previousResults: Array<{ ok: boolean; data?: unknown }> }) => {
      const result = [...context.previousResults].reverse().find(item => (
        item.ok && typeof item.data === 'object' && item.data !== null
        && (item.data as { operation?: string }).operation === 'read'
      ));
      if (!result || typeof result.data !== 'object' || result.data === null) throw new Error('Expected an observed browser read.');
      return result.data as { blocks?: Array<{ type: string; ref: string; links?: Array<{ href: string }> }> };
    };
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: {
        next: async context => {
          const step = decisionIndex++;
          if (step === 0) return { type: 'action', tool: 'browser.navigate', input: { url: guessedUrl } };
          if (step === 1) return { type: 'action', tool: 'browser.read', input: {} };
          if (step === 2) {
            const link = latestRead(context).blocks?.flatMap(block => block.links ?? []).find(item => item.href === resultUrl);
            if (!link) throw new Error('The search result did not expose its observed href.');
            return { type: 'action', tool: 'browser.navigate', input: { url: link.href } };
          }
          if (step === 3) return { type: 'action', tool: 'browser.read', input: {} };
          if (step === 4) {
            const table = latestRead(context).blocks?.find(block => block.type === 'table');
            if (!table) throw new Error('The ranked browser read did not return a table ref.');
            return { type: 'action', tool: 'fs.write', input: { path: 'forex.txt', sourceRef: table.ref, format: 'text' } };
          }
          if (step === 5) return { type: 'action', tool: 'app.openFile', input: { path: 'forex.txt', application: 'text-editor' } };
          return { type: 'complete' };
        },
      },
    });

    const result = await runtime.run({
      threadId: 'forex-source-ref',
      userMessage,
      task: browserResearchTask({ threadId: 'forex-source-ref', userMessage }),
    });

    expect(result.status).toBe('completed');
    const navigations = tools.invocations.filter(invocation => invocation.tool === 'browser.navigate');
    expect(navigations.map(invocation => invocation.input)).toEqual([
      { url: searchUrl },
      { url: resultUrl },
    ]);
    const navigationResults = result.steps.filter(step => step.phase === 'act' && step.toolName === 'browser.navigate').map(step => step.toolResult?.data as { urlProvenance?: string });
    expect(navigationResults.map(data => data.urlProvenance)).toEqual(['duckduckgo-search', 'page-link']);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.read').map(invocation => invocation.input))
      .toEqual([{ query: 'exchange rate data' }, { query: 'exchange rate data' }]);
    const selectedRead = tools.invocations.filter(invocation => invocation.tool === 'browser.read')[1];
    expect((selectedRead?.result.data as { blocks: Array<{ type: string }> }).blocks[0]?.type).toBe('table');
    const saved = guest.getFile('forex.txt') ?? '';
    expect(saved).toContain('Exchange Rate of 24-September-2026 10:00 AM');
    expect(saved).toContain('USD | USD | 1 | 152.28 | 153.05 | 153.65');
    expect(saved).toContain('Euro | EUR | 1 | 173.65 | 173.65 | 175.36');
    expect(saved).toContain('Japanese Yen | JPY | 10 | 9.69 | 9.69 | 9.78');
    expect(saved).toContain('Indian Currency | INR | 100 | 160.00 | 160.00 | 160.15');
    expect(saved).not.toContain('Current Account');
    expect(saved).not.toContain('Footer links');
    expect(guest.desktopWindows.find(window => window.focused)?.title).toContain('forex.txt');
  });

  it('uses explicit semantic search and targeted reads without runtime-injected extraction', async () => {
    const searchUrl = 'https://duckduckgo.com/?q=Neplex+Technologies';
    const resultUrl = 'https://neplextech.com/projects';
    const guest = new MockGuestTransport({
      pages: {
        [searchUrl]: `<html><body><main><h1>Search results</h1><p>Neplex Technologies projects listing content.</p><a href="${resultUrl}">Neplex Technologies projects</a></main></body></html>`,
        [resultUrl]: '<html><body><main><h1>Neplex projects</h1><p>Project details content.</p></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: searchUrl } },
      { type: 'action', tool: 'browser.read', input: { query: 'Neplex projects' } },
      { type: 'action', tool: 'browser.navigate', input: { url: resultUrl } },
      { type: 'action', tool: 'browser.read', input: { query: 'Neplex projects' } },
      { type: 'complete' },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
    });

    const result = await runtime.run({
      threadId: 'search-workflow',
      userMessage: 'See what projects Neplex Technologies makes. Use DuckDuckGo and look for them.',
      task: browserResearchTask({
        threadId: 'search-workflow',
        userMessage: 'See what projects Neplex Technologies makes. Use DuckDuckGo and look for them.',
      }),
    });

    expect(result.status).toBe('completed');
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.navigate').map(invocation => invocation.input)).toEqual([
      { url: searchUrl },
      { url: resultUrl },
    ]);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.read')).toHaveLength(2);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.snapshot')).toHaveLength(0);
  });

  it('continues from a redirected page instead of repeating the source URL', async () => {
    const sourceUrl = 'https://github.com/twlite.png';
    const finalUrl = 'https://avatars.githubusercontent.com/u/123456?v=4';
    const guest = new MockGuestTransport({
      redirects: { [sourceUrl]: finalUrl },
      pages: { [finalUrl]: '<html><body><main><h1>twlite GitHub profile</h1><p>Profile image page content.</p></main></body></html>' },
    });
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: new ScriptedDecisionProvider([
        { type: 'action', tool: 'browser.navigate', input: { url: sourceUrl } },
        { type: 'action', tool: 'browser.read', input: { mode: 'readable' } },
        { type: 'complete' },
      ]),
    });

    const result = await runtime.run({
      threadId: 'redirect-research-thread',
      userMessage: `Open ${sourceUrl} and read the page.`,
      task: browserResearchTask({
        threadId: 'redirect-research-thread',
        userMessage: `Open ${sourceUrl} and read the page.`,
      }),
    });

    expect(result.status).toBe('completed');
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.navigate').map(invocation => invocation.input)).toEqual([
      { url: sourceUrl },
    ]);
    expect(tools.invocations.filter(invocation => invocation.tool === 'browser.read')).toHaveLength(1);
    expect(result.steps.some(step => step.toolName === 'browser.read')).toBe(true);
  });

  it('answers conversational plans without executing computer-use tools', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    let decisionCalls = 0;
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      taskPlanner: {
        createTask: async input => ({
          id: 'conversation-task',
          threadId: input.threadId,
          goal: input.userMessage,
          criteria: [],
        }),
      },
      decisionProvider: {
        next: async () => {
          decisionCalls += 1;
          return { type: 'complete', reasoningSummary: 'Answer directly.' };
        },
      },
    });

    const result = await runtime.run({
      threadId: 'conversation-thread',
      userMessage: 'Who are you?',
      conversation: [{
        id: 'message-1',
        threadId: 'conversation-thread',
        role: 'user',
        content: 'Who are you?',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
    });

    expect(result.status).toBe('completed');
    expect(result.finalVerification).toEqual({ complete: true, criteria: [], summary: 'Response ready.' });
    expect(result.steps.some(step => step.phase === 'act')).toBe(false);
    expect(decisionCalls).toBe(0);
  });

  it('stops repeated rejected completion decisions before the step budget', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: new ScriptedDecisionProvider([
        { type: 'complete' },
        { type: 'complete' },
        { type: 'complete' },
      ]),
      budgets: { maxSteps: 12, maxRepeatedAction: 3 },
    });

    const result = await runtime.run({
      threadId: 'completion-loop',
      userMessage: 'Finish the task.',
      task: {
        id: 'completion-loop-task',
        threadId: 'completion-loop',
        goal: 'Finish the task.',
        criteria: [{ type: 'file.exists', path: '/home/helm/workspace/missing.txt' }],
      },
    });

    expect(result.status).toBe('failed');
    expect(result.run.error?.code).toBe('COMPLETION_REJECTED');
    expect(result.steps.filter(step => step.phase === 'complete')).toHaveLength(3);
  });

  it('loads recalled memories for the new thread before asking the decision provider', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const memory = {
      id: 'memory-browser-preference',
      content: 'The user prefers the browser to open in a focused window.',
      kind: 'preference' as const,
      importance: 0.9,
      metadata: {},
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    let recalledFor: { threadId: string; userMessage: string } | undefined;
    let plannerMemories: typeof memory[] | undefined;
    let contextMemories: typeof memory[] | undefined;
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      memories: async input => {
        recalledFor = { threadId: input.threadId, userMessage: input.userMessage };
        return [memory];
      },
      taskPlanner: {
        createTask: async input => {
          plannerMemories = input.memories;
          return {
            id: 'memory-task',
            threadId: input.threadId,
            goal: input.userMessage,
            criteria: [{ type: 'browser.url', url: DEMO_PAGE_URL }],
          };
        },
      },
      decisionProvider: {
        next: async context => {
          contextMemories = context.memories;
          return { type: 'blocked', reason: 'test complete' };
        },
      },
    });

    const result = await runtime.run({
      threadId: 'new-thread',
      userMessage: 'Open the browser using my usual preference.',
    });

    expect(result.status).toBe('blocked');
    expect(recalledFor).toEqual({
      threadId: 'new-thread',
      userMessage: 'Open the browser using my usual preference.',
    });
    expect(plannerMemories).toEqual([memory]);
    expect(contextMemories).toEqual([memory]);
  });

  it('injects steering messages into the next decision context of an active run', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const contexts: string[][] = [];
    let drainCalls = 0;
    const steering = {
      id: 'steer-1',
      threadId: 'steering-thread',
      role: 'user' as const,
      content: 'Use the existing workspace file name.',
      metadata: { source: 'steer' },
      createdAt: '2026-01-01T00:00:01.000Z',
    };
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: {
        next: async context => {
          contexts.push((context.conversation ?? []).map(message => message.content));
          return contexts.length === 1
            ? { type: 'action', tool: 'fs.write', input: { path: '/home/helm/workspace/steered.txt', content: 'done' } }
            : { type: 'complete' };
        },
      },
    });

    const result = await runtime.run({
      threadId: 'steering-thread',
      userMessage: 'Create a file.',
      conversation: [{
        id: 'user-1',
        threadId: 'steering-thread',
        role: 'user',
        content: 'Create a file.',
        metadata: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }],
      task: {
        id: 'steering-task',
        threadId: 'steering-thread',
        goal: 'Create a file.',
        criteria: [{ type: 'file.exists', path: '/home/helm/workspace/steered.txt' }],
      },
      drainSteering: () => {
        drainCalls += 1;
        return drainCalls === 2 ? [steering] : [];
      },
    });

    expect(result.status).toBe('completed');
    expect(contexts[0]).toEqual(['Create a file.']);
    expect(contexts[1]).toEqual(['Create a file.', 'Use the existing workspace file name.']);
  });

  it('completes the scripted demo only after final verification passes', async () => {
    const demo = createScriptedDemo();
    const result = await demo.runtime.run(demo.task);

    expect(result.status).toBe('completed');
    expect(result.finalVerification?.complete).toBe(true);
    expect(demo.guest.getFile('/home/helm/workspace/demo.txt')).toContain(DEMO_PAGE_TEXT);
    const write = demo.tools.invocations.find(invocation => invocation.tool === 'fs.write');
    expect(write?.input).toMatchObject({ path: '/home/helm/workspace/demo.txt' });
    expect((write?.input as { content?: string } | undefined)?.content).toContain(DEMO_PAGE_TEXT);
  });

  it('cannot silently accept a premature completion request', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: DEMO_PAGE_URL } },
      { type: 'complete' },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
      budgets: { maxSteps: 4 },
    });

    const result = await runtime.run({
      id: 'premature',
      threadId: 'thread',
      goal: 'Create and open a file.',
      criteria: [
        { type: 'file.exists', path: '/home/helm/workspace/demo.txt' },
        { type: 'window.focused', application: 'text-editor', titleIncludes: 'demo.txt' },
      ],
    });

    expect(result.status).not.toBe('completed');
    expect(result.history[1]?.verification?.complete).toBe(false);
    expect(result.history[1]?.verification?.criteria.every(criterion => !criterion.passed)).toBe(true);
  });

  it('does not execute a successful action again when the model repeats it', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: 'https://twlite.dev' } },
      { type: 'action', tool: 'browser.navigate', input: { url: 'https://twlite.dev' } },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
    });

    const result = await runtime.run({
      id: 'auto-complete',
      threadId: 'thread',
      goal: 'Navigate to twlite.dev.',
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.status).toBe('completed');
    expect(result.finalVerification?.complete).toBe(true);
    expect(result.history).toHaveLength(1);
    expect(provider.index).toBe(2);
  });

  it('allows useful follow-up work after navigation verification passes', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: 'https://twlite.dev' } },
      { type: 'action', tool: 'browser.read', input: { mode: 'readable' } },
      { type: 'complete' },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
    });

    const result = await runtime.run({
      id: 'follow-up',
      threadId: 'thread',
      goal: 'Read the page after navigating to https://twlite.dev.',
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.status).toBe('completed');
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.read')).toBe(true);
  });

  it('does not infer extra page-reading work from prose in a legacy task', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: 'https://twlite.dev' } },
      { type: 'complete' },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
    });

    const result = await runtime.run({
      id: 'page-information',
      threadId: 'thread',
      goal: 'Visit https://twlite.dev and extract information from the page.',
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.status).toBe('completed');
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.read')).toBe(false);
  });

  it('does not inject a page read when the decision provider completes', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: 'https://twlite.dev' } },
      { type: 'complete' },
      { type: 'complete' },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
    });

    const result = await runtime.run({
      id: 'page-information-auto-read',
      threadId: 'thread',
      userMessage: 'Go to twlite.dev and tell me what is on the page.',
      goal: 'Go to twlite.dev and tell me what is on the page.',
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.status).toBe('completed');
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.read')).toBe(false);
    expect(result.steps.filter(step => step.phase === 'act' && step.toolName === 'browser.navigate')).toHaveLength(1);
  });

  it('accepts ranked reads and rejects unbounded reads at the tool schema boundary', async () => {
    const guest = new MockGuestTransport({ pages: {
      'https://rates.example.test/': '<html><body><nav>Home Deposit Accounts</nav><h2>Exchange Rate Data</h2><table><tr><th>Currency</th><th>Buying</th><th>Selling</th></tr><tr><td>USD</td><td>152.28</td><td>153.65</td></tr></table></body></html>',
    } });
    const tools = createGuestToolRegistry(guest);
    await guest.request('browser.navigate', { url: 'https://rates.example.test/' });
    const queryAsRead = await tools.execute('browser.read', { query: 'exchange rates', mode: 'readable' });
    const unboundedRead = await tools.execute('browser.read', { mode: 'document', maxChars: 100_000 });
    const searchWithoutQuery = await tools.execute('browser.search', {});

    expect(queryAsRead).toMatchObject({ ok: true, data: { pageType: 'data_table', query: 'exchange rates' } });
    expect((queryAsRead.data as { blocks: Array<{ type: string }> }).blocks[0]?.type).toBe('table');
    expect(unboundedRead).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(searchWithoutQuery).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });
    expect(guest.browser.url).toBe('https://rates.example.test/');
  });

  it('detects repeated actions even when the observed browser state changes', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    let observationCount = 0;
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'fs.exists', input: { path: '/home/helm/workspace/missing.txt' } },
      { type: 'action', tool: 'fs.exists', input: { path: '/home/helm/workspace/missing.txt' } },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
      budgets: { maxSteps: 4, maxRepeatedAction: 2 },
      observe: {
        observe: async input => ({
          timestamp: observationCount++,
          browser: { url: `https://changing-${observationCount}.test`, loaded: true },
          task: {
            completedCriteria: input.completedCriteria,
            remainingCriteria: input.remainingCriteria,
          },
        }),
      },
    });

    const result = await runtime.run({
      id: 'changing-observation-loop',
      threadId: 'thread',
      goal: 'Do not loop.',
      criteria: [{ type: 'file.exists', path: '/home/helm/workspace/never.txt' }],
    });

    expect(result.status).toBe('failed');
    expect(result.run.error?.code).toBe('TOOL_LOOP_DETECTED');
  });

  it('enforces the step budget and detects repeated action/state loops', async () => {
    const loop = new LoopDetector(2);
    const fingerprint = 'same-action-and-state';
    expect(loop.record(fingerprint).loopDetected).toBe(false);
    expect(loop.record(fingerprint).loopDetected).toBe(true);

    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'fs.exists', input: { path: '/home/helm/workspace/missing.txt' } },
      { type: 'action', tool: 'fs.exists', input: { path: '/home/helm/workspace/missing.txt' } },
      { type: 'action', tool: 'fs.exists', input: { path: '/home/helm/workspace/missing.txt' } },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
      budgets: { maxSteps: 3, maxRepeatedAction: 2 },
    });
    const result = await runtime.run({
      id: 'loop',
      threadId: 'thread',
      goal: 'Do not loop.',
      criteria: [{ type: 'file.exists', path: '/home/helm/workspace/never.txt' }],
    });

    expect(result.status).toBe('failed');
    expect(result.run.error?.code).toBe('TOOL_LOOP_DETECTED');
  });

  it('persists the running-to-completed transition and supports cancellation', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const statuses: string[] = [];
    const eventTypes: string[] = [];
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: DEMO_PAGE_URL } },
      { type: 'complete' },
    ]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier,
      decisionProvider: provider,
      repository: { saveRun: run => statuses.push(run.status) },
      events: { emit: event => eventTypes.push(event.type) },
    });
    const completed = await runtime.run({
      id: 'transitions',
      threadId: 'thread',
      goal: 'Navigate and verify.',
      criteria: [{ type: 'browser.url', url: DEMO_PAGE_URL }],
    });
    expect(completed.status).toBe('completed');
    expect(statuses).toEqual(['running', 'completed']);
    expect(eventTypes).toContain('run.started');
    expect(eventTypes).toContain('run.completed');

    const slowTools = new ToolRegistry();
    slowTools.register({
      name: 'wait',
      description: 'Wait until cancelled.',
      inputSchema: z.object({}),
      execute: async (_input, context) => await new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }),
    });
    const slowRuntime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: slowTools,
      verifier,
      decisionProvider: new ScriptedDecisionProvider([
        { type: 'action', tool: 'wait', input: {} },
      ]),
    });
    const pending = slowRuntime.run({
      id: 'cancel',
      threadId: 'thread',
      goal: 'Cancel.',
      criteria: [{ type: 'file.exists', path: '/home/helm/workspace/nope.txt' }],
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(slowRuntime.cancel()).toBe(true);
    expect((await pending).status).toBe('cancelled');
  });
});
