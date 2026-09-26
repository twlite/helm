import { describe, expect, it } from 'bun:test';
import type {
  EnvironmentObservation,
  Fact,
  OrchestratorDecision,
  TaskDefinition,
  WorkerAction,
  WorkerResult,
} from '@helm/shared';

import { AgentRuntime } from '../../src/agent/runtime';
import { browserResearchSearchUrl } from '../../src/agent/browser-research';
import { deterministicObjectiveAction, objectiveForRequirement, ScriptedOrchestratorProvider } from '../../src/agent/orchestrator';
import { createTaskState, progressFingerprint, verifyTaskState } from '../../src/agent/task-state';
import type { WorkerContext, WorkerProvider } from '../../src/agent/types';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { DEMO_PAGE_URL, MockGuestTransport } from '../../src/tools/mock-guest-transport';
import { deriveBrowserReadQuery } from '@helm/shared';

function objective(id: string, kind: 'browser' | 'filesystem', description: string, requirementId: string) {
  return { id, kind, description, requirementIds: [requirementId], rationale: 'test objective' } as const;
}

function fact(id: string, value: string, evidenceId: string): Fact {
  return {
    id,
    value,
    origin: 'observed',
    confidence: 'observed',
    evidenceIds: [evidenceId],
    observedAt: new Date().toISOString(),
  };
}

class FunctionalWorker implements WorkerProvider {
  private index = 0;

  constructor(private readonly functions: Array<(context: WorkerContext) => Promise<WorkerResult>>) {}

  async execute(context: WorkerContext): Promise<WorkerResult> {
    const functionToRun = this.functions[Math.min(this.index, this.functions.length - 1)];
    this.index += 1;
    return functionToRun(context);
  }
}

async function executeAction(context: WorkerContext, tool: string, input: Record<string, unknown>, id: string): Promise<WorkerAction> {
  const result = await context.execute.execute(tool, input);
  return { id, tool, input, result };
}

function taskWithRequirements(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
  return {
    id: 'orchestrated-task',
    threadId: 'orchestrated-thread',
    goal: 'Collect observed release facts and write the result.',
    originalRequest: 'Open GitHub, inspect oven-sh/bun latest release, and write the latest release version, release URL, repository name, and current date to ~/Desktop/helm-demo/result.txt.',
    criteria: [],
    requirements: [
      { id: 'latestReleaseVersion', description: 'Observe the latest release version.', type: 'fact', mandatory: true, target: { factId: 'latestReleaseVersion' } },
      { id: 'releaseUrl', description: 'Observe the release URL.', type: 'fact', mandatory: true, target: { factId: 'releaseUrl' } },
      { id: 'repositoryName', description: 'Use the requested repository name.', type: 'fact', mandatory: true, target: { factId: 'repositoryName' } },
      { id: 'currentDate', description: 'Record the current date.', type: 'fact', mandatory: true, target: { factId: 'currentDate' } },
      { id: 'outputFile', description: 'Write the observed facts to result.txt.', type: 'filesystem', mandatory: true, target: { path: '~/Desktop/helm-demo/result.txt', mode: 'contains-facts', factIds: ['latestReleaseVersion', 'releaseUrl', 'repositoryName', 'currentDate'] } },
    ],
    ...overrides,
  };
}

function desktopReleaseTask(): TaskDefinition {
  return {
    id: 'desktop-release-task',
    threadId: 'desktop-release-thread',
    goal: 'Find the latest oven-sh/bun release and write it to the requested Desktop file.',
    originalRequest: 'Open GitHub and go to the oven-sh/bun repository. Find the latest release version and its release date. Then create a folder called helm-demo on the Desktop and write a bun-release.md file containing the repository name, latest version, release date, release URL, and the current date.',
    criteria: [],
    requirements: [
      { id: 'browserResearch', description: 'Collect readable evidence from the relevant public web page.', type: 'fact', mandatory: true, target: { factId: 'pageContent' } },
      { id: 'latestReleaseVersion', description: 'Determine the latest stable release version.', type: 'fact', mandatory: true, target: { factId: 'latestReleaseVersion' } },
      { id: 'releaseDate', description: 'Determine the release date.', type: 'fact', mandatory: true, target: { factId: 'releaseDate' } },
      { id: 'releaseUrl', description: 'Capture the release URL.', type: 'fact', mandatory: true, target: { factId: 'releaseUrl' } },
      { id: 'repositoryName', description: 'Know the repository name.', type: 'fact', mandatory: true, target: { factId: 'repositoryName' } },
      { id: 'currentDate', description: 'Record the current date.', type: 'fact', mandatory: true, target: { factId: 'currentDate' } },
      { id: 'outputDirectory', description: 'Create the requested output directory.', type: 'filesystem', mandatory: true, target: { path: '~/Desktop/helm-demo', mode: 'created', freshness: 'current-run', action: 'fs.mkdir' } },
      { id: 'outputFile', description: 'Create the requested output file with the collected facts.', type: 'filesystem', mandatory: true, target: { path: '~/Desktop/helm-demo/bun-release.md', mode: 'contains-facts', freshness: 'current-run', action: 'fs.write', factIds: ['repositoryName', 'latestReleaseVersion', 'releaseDate', 'releaseUrl', 'currentDate'] } },
    ],
  };
}

function runtimeFor(
  guest: MockGuestTransport,
  decisions: readonly OrchestratorDecision[],
  worker: WorkerProvider,
  budgets?: Record<string, number>,
) {
  const tools = createGuestToolRegistry(guest);
  return new AgentRuntime({
    guestTransport: guest,
    toolRegistry: tools,
    verifier: new CriterionVerifierRegistry(guest),
    decisionProvider: { next: async () => ({ type: 'complete' as const }) },
    orchestrator: new ScriptedOrchestratorProvider(decisions),
    worker,
    budgets,
  });
}

describe('orchestrated agent loop', () => {
  it('requires current-run writes and opens even when an old file and viewer window already exist', async () => {
    const userMessage = "Fetch the exchange rate data from Nepal Rastra Bank's official forex website, save that data to forex.txt, and open it with the text viewer application.";
    const searchUrl = browserResearchSearchUrl(deriveBrowserReadQuery(userMessage));
    const resultUrl = 'https://www.nrb.org.np/forex';
    const rows = [
      ['USD', 'USD', '1', '152.28', '153.05', '153.65'],
      ['Euro', 'EUR', '1', '173.65', '173.65', '175.36'],
      ['Japanese Yen', 'JPY', '10', '9.69', '9.69', '9.78'],
      ['Indian Currency', 'INR', '100', '160.00', '160.00', '160.15'],
      ['British Pound', 'GBP', '1', '205.10', '205.80', '206.50'],
      ['Swiss Franc', 'CHF', '1', '181.20', '181.90', '182.60'],
      ['Australian Dollar', 'AUD', '1', '98.10', '98.50', '99.00'],
      ['Canadian Dollar', 'CAD', '1', '110.10', '110.55', '111.00'],
      ['Singapore Dollar', 'SGD', '1', '112.20', '112.65', '113.10'],
      ['Chinese Yuan', 'CNY', '1', '20.90', '21.00', '21.10'],
      ['Qatari Riyal', 'QAR', '1', '41.50', '41.65', '41.80'],
      ['Saudi Riyal', 'SAR', '1', '40.40', '40.55', '40.70'],
    ];
    const tableHtml = `<table><caption>Exchange Rate of 24-September-2026</caption><thead><tr>
      <th>Currency</th><th>Code</th><th>Unit</th><th>Buying below Deno 50</th><th>Buying 50 and above Deno</th><th>Selling</th>
    </tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    const task: TaskDefinition = {
      id: 'fresh-forex-run',
      threadId: 'fresh-forex-run-thread',
      goal: 'Find the current rates, save the fetched data, and open the new file.',
      originalRequest: userMessage,
      criteria: [],
      requirements: [
        { id: 'browserResearch', description: 'Read current rates from the official source.', type: 'fact', mandatory: true, target: { factId: 'pageContent' } },
        { id: 'outputFile', description: 'Write fetched browser content during this run.', type: 'filesystem', mandatory: true, target: { path: 'forex.txt', mode: 'written-from-artifact', freshness: 'current-run', action: 'fs.write' } },
        { id: 'openFile', description: 'Open the requested file during this run.', type: 'desktop', mandatory: true, target: { path: 'forex.txt', content: 'forex.txt', mode: 'opened', freshness: 'current-run', action: 'app.openFile' } },
      ],
    };
    const guest = new MockGuestTransport({
      initialFiles: { 'forex.txt': 'OLD DATA' },
      pages: {
        [searchUrl]: `<html><body><main><h1>Search results</h1></main><article><h2><a href="https://duckduckgo.com/l/?uddg=${encodeURIComponent(resultUrl)}">Foreign Exchange Rate - Nepal Rastra Bank</a></h2><p>Official foreign exchange rates with currency buying and selling values.</p></article></body></html>`,
        [resultUrl]: `<html><head><title>Nepal Rastra Bank Foreign Exchange Rates</title></head><body><main><h1>Foreign Exchange Rate</h1><h2>Exchange Rate of 24-September-2026</h2>${tableHtml}</main></body></html>`,
      },
    });
    await guest.request('app.openFile', { path: 'forex.txt', application: 'text-editor' });

    const taskState = createTaskState(task);
    const beforeObservation: EnvironmentObservation = {
      timestamp: 1,
      desktop: { windows: guest.desktopWindows },
      task: { completedCriteria: [], remainingCriteria: ['outputFile', 'openFile'] },
    };
    const initialVerification = await verifyTaskState(
      task,
      taskState,
      guest,
      beforeObservation,
      new CriterionVerifierRegistry(guest),
    );
    expect(initialVerification.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'outputFile' }), passed: false }),
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'openFile' }), passed: false }),
    ]));

    const initialTaskState = createTaskState(task);
    const observation: EnvironmentObservation = { timestamp: 1, task: { completedCriteria: [], remainingCriteria: [] } };
    const browserObjective = objectiveForRequirement(initialTaskState, observation, 'browserResearch')!;
    const fileObjective = objectiveForRequirement(initialTaskState, observation, 'outputFile')!;
    const openObjective = objectiveForRequirement(initialTaskState, observation, 'openFile')!;
    const worker = new FunctionalWorker([
      async context => {
        const navigate = await executeAction(context, 'browser.navigate', { url: searchUrl }, 'search-navigation');
        const search = await executeAction(context, 'browser.search', { query: 'Nepal Rastra Bank official foreign exchange rate' }, 'search');
        const searchData = search.result.data as { results?: Array<{ type: string; ref: string; href?: string }> };
        const official = searchData.results?.find(item => item.type === 'search_result' && item.href === resultUrl);
        if (!official) throw new Error('DuckDuckGo search did not return the observed official href.');
        const invented = await executeAction(context, 'browser.navigate', { url: 'https://www.nrb.org.np' }, 'invented-host');
        const opened = await executeAction(context, 'browser.open', { ref: official.ref }, 'open-result-ref');
        const read = await executeAction(context, 'browser.read', { query: 'exchange rate currency buying selling' }, 'read-rates');
        const readData = read.result.data as { sections?: Array<{ text: string }>; blocks?: Array<{ type: string; ref: string }> };
        const receiptId = ((read.result.evidence as { receipt?: { id?: string } } | undefined)?.receipt?.id) ?? 'missing-receipt';
        const pageContent = readData.sections?.[0]?.text.split('\n')[0] ?? 'Foreign Exchange Rate';
        return {
          status: 'completed', worker: 'browser', objectiveId: context.objective.id,
          actions: [navigate, search, invented, opened, read],
          facts: [fact('pageContent', pageContent, receiptId)], evidence: [], artifacts: [], blockers: [], environmentChanged: true,
        };
      },
      async context => {
        const previousRead = [...context.state.recentActions].reverse().find(action => action.tool === 'browser.read' && action.result.ok);
        const blocks = (previousRead?.result.data as { blocks?: Array<{ type: string; ref: string }> } | undefined)?.blocks;
        const table = blocks?.find(block => block.type === 'table');
        if (!table) throw new Error('No table ref was retained from the browser worker.');
        const intermediate = await executeAction(context, 'fs.write', { path: 'forex.txt', content: 'INTERMEDIATE VERSION' }, 'write-intermediate');
        const finalWrite = await executeAction(context, 'fs.write', { path: 'forex.txt', sourceRef: table.ref, format: 'text' }, 'write-from-table');
        return {
          status: 'completed', worker: 'filesystem', objectiveId: context.objective.id,
          actions: [intermediate, finalWrite], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true,
        };
      },
      async context => {
        const open = await executeAction(context, 'app.openFile', { path: 'forex.txt', application: 'text-editor' }, 'open-file');
        return {
          status: 'completed', worker: 'desktop', objectiveId: context.objective.id,
          actions: [open], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true,
        };
      },
    ]);
    const result = await runtimeFor(guest, [
      { type: 'objective', objective: browserObjective },
      { type: 'objective', objective: fileObjective },
      { type: 'objective', objective: openObjective },
    ], worker, { maxSteps: 3 }).run({ threadId: task.threadId, userMessage, task });

    expect(result.status).toBe('completed');
    expect(result.finalVerification?.complete).toBe(true);
    expect(guest.getFile('forex.txt')).toContain('Saudi Riyal | SAR | 1 | 40.40 | 40.55 | 40.70');
    expect(guest.getFile('forex.txt')).not.toContain('OLD DATA');
    expect(guest.getFile('forex.txt')).not.toContain('INTERMEDIATE VERSION');
    const browserVerify = result.steps.find(step => step.phase === 'verify' && step.worker === 'browser')?.verification;
    expect(browserVerify?.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'outputFile' }), passed: false }),
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'openFile' }), passed: false }),
    ]));
    const filesystemVerify = result.steps.find(step => step.phase === 'verify' && step.worker === 'filesystem')?.verification;
    expect(filesystemVerify?.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'outputFile' }), passed: true }),
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'openFile' }), passed: false }),
    ]));

    const actions = result.run.state?.recentActions ?? [];
    const writes = actions.filter(action => action.tool === 'fs.write');
    expect(writes).toHaveLength(2);
    expect(writes[0]?.result.data).toMatchObject({ existedBefore: true, changed: true });
    expect(writes[1]?.result.data).toMatchObject({ existedBefore: true, changed: true, sourceType: 'table' });
    const writeReceipts = writes.map(action => (action.result.evidence as { receipt: { id: string; effect: { changed?: boolean; writePerformed?: boolean; beforeSha256?: string; sha256?: string } } }).receipt);
    expect(writeReceipts[0]).toMatchObject({ tool: 'fs.write', ok: true, effect: { changed: true, writePerformed: true } });
    expect(writeReceipts[1]).toMatchObject({ tool: 'fs.write', ok: true, effect: { changed: true, writePerformed: true, beforeSha256: writes[0]?.result.data && (writes[0].result.data as { sha256: string }).sha256 } });
    const artifacts = result.run.state?.artifacts.filter(artifact => artifact.path.endsWith('/forex.txt')) ?? [];
    expect(artifacts.map(artifact => artifact.version)).toEqual([1, 2]);
    expect(artifacts[0]?.sha256).not.toBe(artifacts[1]?.sha256);
    expect(artifacts[1]).toMatchObject({
      sha256: (writes[1]?.result.data as { sha256: string }).sha256,
      sourceRef: (writes[1]?.result.data as { sourceRef: string }).sourceRef,
      sourceType: 'table',
      writeReceiptId: writeReceipts[1]?.id,
      version: 2,
    });
    expect(guest.desktopWindows.find(window => window.focused)?.title).toContain('forex.txt');
    const openAction = actions.find(action => action.tool === 'app.openFile');
    expect(openAction?.result.evidence).toMatchObject({ receipt: { tool: 'app.openFile', ok: true } });
  });

  it('navigates explicit destinations but leaves semantic page retrieval to the model', () => {
    const task = taskWithRequirements({
      id: 'deterministic-browser-research',
      requirements: [
        { id: 'browserDestination', description: 'Reach the requested page.', type: 'browser', mandatory: true, target: { url: 'https://twlite.dev' } },
        { id: 'browserResearch', description: 'Collect readable page content.', type: 'fact', mandatory: true, target: { factId: 'pageContent' } },
      ],
    });
    const state = createTaskState(task);
    const research = objectiveForRequirement(state, { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['browserResearch'] } }, 'browserResearch');
    const destination = objectiveForRequirement(state, { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['browserDestination'] } }, 'browserDestination');
    if (!research || !destination) throw new Error('Expected browser objectives.');

    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      browser: { url: 'https://twlite.dev', loaded: true },
      task: { completedCriteria: [], remainingCriteria: ['browserResearch'] },
    }, research)).toBeUndefined();
    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      browser: { url: 'about:blank', loaded: true },
      task: { completedCriteria: [], remainingCriteria: ['browserDestination', 'browserResearch'] },
    }, destination)).toMatchObject({ tool: 'browser.navigate', input: { url: 'https://twlite.dev' } });
  });

  it('treats a successful redirect as the requested browser destination', async () => {
    const sourceUrl = 'https://github.com/twlite.png';
    const finalUrl = 'https://avatars.githubusercontent.com/u/123456?v=4';
    const guest = new MockGuestTransport({
      redirects: { [sourceUrl]: finalUrl },
      pages: { [finalUrl]: '<html><body><p>profile image</p></body></html>' },
    });
    const destination = objective('redirect-destination', 'browser', 'Reach the requested image URL.', 'browserDestination');
    const worker = new FunctionalWorker([async context => {
      const action = await executeAction(context, 'browser.navigate', { url: sourceUrl }, 'navigate');
      return {
        status: 'completed',
        worker: 'browser',
        objectiveId: context.objective.id,
        actions: [action],
        facts: [],
        evidence: [],
        artifacts: [],
        blockers: [],
        environmentChanged: true,
      };
    }]);
    const result = await runtimeFor(guest, [{ type: 'objective', objective: destination }], worker, { maxSteps: 1 }).run({
      threadId: 'redirect-destination-thread',
      userMessage: `Open ${sourceUrl}.`,
      task: taskWithRequirements({
        id: 'redirect-destination-task',
        threadId: 'redirect-destination-thread',
        goal: 'Reach the requested image URL.',
        originalRequest: `Open ${sourceUrl}.`,
        requirements: [{
          id: 'browserDestination',
          description: 'Reach the URL explicitly supplied by the user.',
          type: 'browser',
          mandatory: true,
          target: { url: sourceUrl },
        }],
      }),
    });

    expect(result.status).toBe('completed');
    expect(guest.browserState.url).toBe(finalUrl);
    expect(result.run.state?.completedRequirementIds).toContain('browserDestination');
    const workerActions = result.steps
      .filter(step => step.phase === 'act')
      .flatMap(step => step.workerResult?.actions ?? []);
    expect(workerActions).toHaveLength(1);
    expect(workerActions[0]?.result).toMatchObject({
      data: { url: finalUrl },
      evidence: { receipt: { effect: { requestedUrl: sourceUrl, urlAfter: finalUrl, redirected: true } } },
    });
  });

  it('keeps file contents under model control while retaining mechanical viewer actions', () => {
    const task = taskWithRequirements({
      id: 'page-file-task',
      threadId: 'page-file-thread',
      requirements: [
        {
          id: 'browserDestination',
          description: 'Reach the requested page.',
          type: 'browser',
          mandatory: true,
          target: { url: 'https://twlite.dev' },
        },
        {
          id: 'outputDirectory',
          description: 'Create the requested output directory.',
          type: 'filesystem',
          mandatory: true,
          target: { path: '~/Desktop', mode: 'exists' },
        },
        {
          id: 'outputFile',
          description: 'Write the observed page content.',
          type: 'filesystem',
          mandatory: true,
          target: { path: '~/Desktop/twlite.md', mode: 'contains-facts', factIds: ['pageContent'] },
        },
        {
          id: 'openFile',
          description: 'Open the requested file in the text viewer.',
          type: 'desktop',
          mandatory: true,
          target: { path: '~/Desktop/twlite.md', content: 'twlite.md' },
        },
      ],
    });
    const state = createTaskState(task);
    state.facts.push(fact('pageContent', 'The observed twlite page.', 'receipt-extract'));
    const outputObjective = objectiveForRequirement(
      state,
      { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['outputFile'] } },
      'outputFile',
    );
    const destinationObjective = objectiveForRequirement(
      state,
      { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['browserDestination'] } },
      'browserDestination',
    );
    const directoryObjective = objectiveForRequirement(
      state,
      { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['outputDirectory'] } },
      'outputDirectory',
    );
    const openObjective = objectiveForRequirement(
      state,
      { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['openFile'] } },
      'openFile',
    );
    if (!outputObjective || !openObjective || !destinationObjective || !directoryObjective) throw new Error('Expected page-to-file objectives.');

    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      browser: { url: 'about:blank', loaded: true },
      task: { completedCriteria: [], remainingCriteria: ['browserDestination'] },
    }, destinationObjective)).toMatchObject({
      tool: 'browser.navigate',
      input: { url: 'https://twlite.dev' },
    });
    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      task: { completedCriteria: [], remainingCriteria: ['outputDirectory'] },
    }, directoryObjective)).toMatchObject({
      tool: 'fs.mkdir',
      input: { path: '~/Desktop' },
    });

    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      desktop: { windows: [] },
      task: { completedCriteria: [], remainingCriteria: ['outputFile'] },
    }, outputObjective)).toBeUndefined();
    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      desktop: { windows: [] },
      task: { completedCriteria: [], remainingCriteria: ['openFile'] },
    }, openObjective)).toMatchObject({
      tool: 'app.openFile',
      input: { path: '~/Desktop/twlite.md' },
    });
    expect(deterministicObjectiveAction(state, {
      timestamp: 1,
      desktop: { windows: [{ id: 'text-editor', title: 'twlite.md - Text Editor', focused: true }] },
      task: { completedCriteria: [], remainingCriteria: ['openFile'] },
    }, openObjective)).toBeUndefined();
  });

  it('does not complete a page-summary file task when an error was saved instead of readable page output', async () => {
    const task = taskWithRequirements({
      id: 'summary-file-task',
      threadId: 'summary-file-thread',
      requirements: [
        {
          id: 'browserResearch',
          description: 'Collect readable evidence from the requested page.',
          type: 'fact',
          mandatory: true,
          target: { factId: 'pageContent' },
        },
        {
          id: 'outputFile',
          description: 'Create the requested summary file.',
          type: 'filesystem',
          mandatory: true,
          target: { path: 'kd.txt', mode: 'non-empty' },
        },
      ],
    });
    const guest = new MockGuestTransport();
    await guest.request('fs.write', { path: 'kd.txt', content: 'Error: Could not extract page content.' });

    const verification = await verifyTaskState(
      task,
      createTaskState(task),
      guest,
      { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['browserResearch', 'outputFile'] } },
    );

    expect(verification.complete).toBe(false);
    expect(verification.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'browserResearch' }), passed: false }),
      expect.objectContaining({ requirement: expect.objectContaining({ id: 'outputFile' }), passed: true }),
    ]));
  });

  it('recovers when the orchestrator mistakes an unmet browser requirement for a blocker', async () => {
    const guest = new MockGuestTransport();
    const worker = new FunctionalWorker([async context => {
      const navigate = await executeAction(context, 'browser.navigate', { url: 'https://github.com/oven-sh/bun' }, 'navigate');
      const extract = await executeAction(context, 'browser.read', { mode: 'readable' }, 'read');
      return {
        status: 'completed', worker: 'browser', objectiveId: context.objective.id,
        actions: [navigate, extract], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true,
      };
    }]);
    const researchOnlyTask = {
      ...desktopReleaseTask(),
      id: 'browser-blocker-recovery-task',
      threadId: 'browser-blocker-recovery',
      requirements: [{
        id: 'browserResearch',
        description: 'Collect readable evidence from the relevant public web page.',
        type: 'fact' as const,
        mandatory: true,
        target: { factId: 'pageContent' },
      }],
    };
    const result = await runtimeFor(guest, [{
      type: 'blocked',
      blocker: {
        code: 'ORCHESTRATOR_BLOCKED',
        message: 'Cannot proceed without completing the browserResearch requirement. Need to perform web research first.',
        requirementIds: ['browserResearch'],
      },
    }], worker, { maxSteps: 2 }).run({
      threadId: 'browser-blocker-recovery',
      userMessage: 'Open GitHub and research the repository.',
      task: researchOnlyTask,
    });

    expect(result.status).not.toBe('blocked');
    expect(result.steps.some(step => step.workerResult?.actions.some(action => action.tool === 'browser.read'))).toBe(true);
    expect(result.run.state?.blockers.some(item => item.code === 'ORCHESTRATOR_BLOCKED_RECOVERED')).toBe(true);
  });

  it('rewrites unsupported search engines before an orchestrated browser worker executes navigation', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const target = objective('search', 'browser', 'Read the relevant search result page.', 'pageContent');
    const worker = new FunctionalWorker([async context => {
      const action = await executeAction(context, 'browser.navigate', {
        url: 'https://www.bing.com/search?q=helm+agent',
      }, 'navigate');
      return {
        status: 'completed',
        worker: 'browser',
        objectiveId: context.objective.id,
        actions: [action],
        facts: [],
        evidence: [],
        artifacts: [],
        blockers: [],
        environmentChanged: true,
      };
    }]);
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(guest),
      decisionProvider: { next: async () => ({ type: 'complete' as const }) },
      orchestrator: new ScriptedOrchestratorProvider([{ type: 'objective', objective: target }]),
      worker,
      budgets: { maxSteps: 1 },
    });

    await runtime.run({
      threadId: 'search-policy-thread',
      userMessage: 'Search for Helm agent information.',
      task: taskWithRequirements({
        id: 'search-policy-task',
        threadId: 'search-policy-thread',
        goal: 'Read a public search result page.',
        originalRequest: 'Search for Helm agent information.',
        requirements: [{
          id: 'pageContent',
          description: 'Read the relevant public search result page.',
          type: 'fact',
          mandatory: true,
          target: { factId: 'pageContent' },
        }],
      }),
    });

    expect(tools.invocations.find(invocation => invocation.tool === 'browser.navigate')?.input).toEqual({
      url: 'https://duckduckgo.com/?q=helm%20agent',
    });
  });

  it('completes the GitHub release to Desktop folder and file workflow', async () => {
    const userMessage = 'Open GitHub and go to the oven-sh/bun repository.';
    const searchUrl = browserResearchSearchUrl(deriveBrowserReadQuery(userMessage));
    const repositoryUrl = 'https://github.com/oven-sh/bun';
    const releaseUrl = 'https://github.com/oven-sh/bun/releases/tag/bun-v1.2.3';
    const guest = new MockGuestTransport({
      pages: {
        [searchUrl]: `<html><body><main><h1>Search results</h1></main><article><a href="${repositoryUrl}">oven-sh/bun repository</a><p>Official repository and latest releases.</p></article></body></html>`,
        [repositoryUrl]: `<html><body><main><h1>oven-sh/bun</h1><p>Latest release bun-v1.2.3</p><a href="${releaseUrl}">Latest release: bun-v1.2.3</a></main></body></html>`,
        [releaseUrl]: '<html><body><h1>oven-sh/bun bun-v1.2.3</h1><p>Released 2026-09-20</p></body></html>',
      },
    });
    const browserObjective = objective('research', 'browser', 'Collect and record the release facts.', 'browserResearch');
    const directoryObjective = objective('directory', 'filesystem', 'Create the requested output directory.', 'outputDirectory');
    const fileObjective = objective('file', 'filesystem', 'Write the requested output file.', 'outputFile');
    const worker = new FunctionalWorker([
      async context => {
        const search = await executeAction(context, 'browser.navigate', { url: repositoryUrl }, 'search');
        const results = await executeAction(context, 'browser.read', { query: 'oven-sh bun repository' }, 'search-results');
        const repository = await executeAction(context, 'browser.navigate', { url: repositoryUrl }, 'repository');
        const repositoryRead = await executeAction(context, 'browser.read', { query: 'oven bun latest release' }, 'repository-read');
        const release = await executeAction(context, 'browser.navigate', { url: releaseUrl }, 'release');
        const extract = await executeAction(context, 'browser.read', { query: 'bun release date 2026-09-20' }, 'read');
        const evidence = extract.result.evidence as { receipt?: { id: string } };
        const evidenceId = evidence.receipt?.id ?? 'missing-receipt';
        return {
          status: 'completed', worker: 'browser', objectiveId: context.objective.id,
          actions: [search, results, repository, repositoryRead, release, extract], facts: [
            fact('latestReleaseVersion', 'bun-v1.2.3', evidenceId),
            fact('releaseDate', '2026-09-20', evidenceId),
            fact('releaseUrl', releaseUrl, evidenceId),
          ], evidence: [], artifacts: [], blockers: [], environmentChanged: true,
        };
      },
      async context => {
        const action = await executeAction(context, 'fs.mkdir', { path: '~/Desktop/helm-demo' }, 'mkdir');
        return { status: 'completed', worker: 'filesystem', objectiveId: context.objective.id, actions: [action], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true };
      },
      async context => {
        const values = new Map(context.state.facts.map(item => [item.id, String(item.value)]));
        const content = [
          `Repository: ${values.get('repositoryName')}`,
          `Latest version: ${values.get('latestReleaseVersion')}`,
          `Release date: ${values.get('releaseDate')}`,
          `Release URL: ${values.get('releaseUrl')}`,
          `Current date: ${values.get('currentDate')}`,
        ].join('\n');
        const action = await executeAction(context, 'fs.write', { path: '~/Desktop/helm-demo/bun-release.md', content }, 'write');
        return { status: 'completed', worker: 'filesystem', objectiveId: context.objective.id, actions: [action], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true };
      },
    ]);

    const result = await runtimeFor(guest, [
      { type: 'objective', objective: browserObjective },
      { type: 'objective', objective: directoryObjective },
      { type: 'objective', objective: fileObjective },
    ], worker, { maxSteps: 3 }).run({
      threadId: 'desktop-release-thread',
      userMessage,
      task: desktopReleaseTask(),
    });

    expect(result.status).toBe('completed');
    expect(guest.browserState.url).toBe(releaseUrl);
    const navigations = result.steps.flatMap(step => step.workerResult?.actions ?? []).filter(action => action.tool === 'browser.navigate');
    expect(navigations.slice(0, 3).map(action => action.result.data && 'url' in action.result.data ? action.result.data.url : undefined))
      .toEqual([searchUrl, repositoryUrl, releaseUrl]);
    expect((navigations[0]?.result.data as { urlProvenance?: string }).urlProvenance).toBe('duckduckgo-search');
    expect((navigations[1]?.result.data as { urlProvenance?: string }).urlProvenance).toBe('search-result');
    expect(guest.getFile('~/Desktop/helm-demo/bun-release.md')).toContain('Release date: 2026-09-20');
    expect((await guest.request('fs.stat', { path: '~/Desktop/helm-demo' })).type).toBe('directory');
    expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining([
      'browserResearch', 'releaseDate', 'outputDirectory', 'outputFile',
    ]));
  });

  it('runs the benchmark shape from observed browser facts to a verified file', async () => {
    const releaseUrl = 'file:///home/helm/release.html';
    const guest = new MockGuestTransport({
      initialFiles: {
        '/home/helm/release.html': '<html><head><title>Bun releases</title></head><body><main><h1>oven-sh/bun v1.2.3</h1><p>Latest stable release v1.2.3</p></main></body></html>',
      },
    });
    const browserObjective = objective('browse', 'browser', 'Determine the latest release facts.', 'latestReleaseVersion');
    const filesystemObjective = objective('write', 'filesystem', 'Write the collected facts.', 'outputFile');
    const decisions: OrchestratorDecision[] = [
      { type: 'objective', objective: browserObjective },
      { type: 'objective', objective: filesystemObjective },
    ];
    const worker = new FunctionalWorker([
      async context => {
        const navigate = await executeAction(context, 'browser.navigate', { url: releaseUrl }, 'navigate');
        const extract = await executeAction(context, 'browser.read', { mode: 'readable' }, 'read');
        const evidenceId = typeof extract.result.evidence === 'object' && extract.result.evidence !== null && 'receipt' in extract.result.evidence
          ? (extract.result.evidence.receipt as { id: string }).id
          : 'missing-receipt';
        return {
          status: 'completed', worker: 'browser', objectiveId: context.objective.id,
          actions: [navigate, extract],
          facts: [fact('latestReleaseVersion', 'v1.2.3', evidenceId), fact('releaseUrl', releaseUrl, evidenceId)],
          evidence: [], artifacts: [], blockers: [], environmentChanged: true,
        };
      },
      async context => {
        const values = new Map(context.state.facts.map(item => [item.id, String(item.value)]));
        const content = [
          `Repository: ${values.get('repositoryName')}`,
          `Latest release: ${values.get('latestReleaseVersion')}`,
          `Release URL: ${values.get('releaseUrl')}`,
          `Date: ${values.get('currentDate')}`,
        ].join('\n');
        const write = await executeAction(context, 'fs.write', { path: '~/Desktop/helm-demo/result.txt', content }, 'write');
        return {
          status: 'completed', worker: 'filesystem', objectiveId: context.objective.id,
          actions: [write], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true,
        };
      },
    ]);
    const result = await runtimeFor(guest, decisions, worker).run({
      threadId: 'orchestrated-thread',
      userMessage: 'Open GitHub and inspect oven-sh/bun.',
      task: taskWithRequirements(),
    });

    expect(result.status).toBe('completed');
    expect(result.finalVerification?.complete).toBe(true);
    expect(guest.getFile('~/Desktop/helm-demo/result.txt')).toContain('v1.2.3');
    expect(result.run.state?.facts.find(item => item.id === 'latestReleaseVersion')?.origin).toBe('observed');
    expect(result.run.state?.completedRequirementIds).toEqual(expect.arrayContaining(['outputFile', 'releaseUrl']));
  });

  it('does not declare completion when the worker makes no progress', async () => {
    const guest = new MockGuestTransport();
    const target = objective('missing', 'filesystem', 'Create the missing file.', 'outputFile');
    const worker = new FunctionalWorker([async context => ({
      status: 'completed', worker: 'filesystem', objectiveId: context.objective.id,
      actions: [], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: false,
    })]);
    const result = await runtimeFor(guest, [{ type: 'complete' }, { type: 'complete' }], worker, { maxSteps: 5, maxRecoveryAttempts: 1 }).run({
      threadId: 'premature-orchestrated',
      userMessage: 'Create the output file.',
      task: taskWithRequirements({ id: 'premature', requirements: [{ id: 'outputFile', description: 'Create output.', type: 'filesystem', mandatory: true, target: { path: '/home/helm/workspace/missing.txt', mode: 'exists' } }] }),
    });

    expect(result.status).toBe('failed');
    expect(result.run.error?.code).toBe('RECOVERY_BUDGET_EXHAUSTED');
    expect(result.run.state?.blockers.some(item => item.code === 'COMPLETION_REJECTED')).toBe(true);
  });

  it('executes the pending objective when the orchestrator proposes completion too early', async () => {
    const guest = new MockGuestTransport();
    const worker = new FunctionalWorker([async context => {
      const write = await executeAction(context, 'fs.write', {
        path: '/home/helm/workspace/twlite.txt',
        content: 'Helm makes local computer use useful.',
      }, 'write');
      return {
        status: 'completed',
        worker: 'filesystem',
        objectiveId: context.objective.id,
        actions: [write],
        facts: [],
        evidence: [],
        artifacts: [],
        blockers: [],
        environmentChanged: true,
      };
    }]);
    const result = await runtimeFor(guest, [{ type: 'complete' }], worker, { maxSteps: 2 }).run({
      threadId: 'premature-success-thread',
      userMessage: 'Save the page contents to twlite.txt.',
      task: taskWithRequirements({
        id: 'premature-success-task',
        requirements: [{
          id: 'outputFile',
          description: 'Create the output file.',
          type: 'filesystem',
          mandatory: true,
          target: { path: '/home/helm/workspace/twlite.txt', mode: 'exists' },
        }],
      }),
    });

    expect(result.status).toBe('completed');
    expect(guest.getFile('/home/helm/workspace/twlite.txt')).toContain('Helm makes local computer use useful.');
    expect(result.run.error).toBeUndefined();
  });

  it('uses recovery state instead of a tool-name loop error when actions do not change state', async () => {
    const guest = new MockGuestTransport();
    const target = objective('stuck', 'browser', 'Inspect a page that never changes.', 'page');
    const worker = new FunctionalWorker([async context => {
      const action = await executeAction(context, 'browser.getState', {}, `state-${context.objective.id}`);
      return { status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [action], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: false };
    }]);
    const result = await runtimeFor(guest, [{ type: 'objective', objective: target }], worker, { maxSteps: 8, noProgressThreshold: 1, maxRecoveryAttempts: 1 }).run({
      threadId: 'stuck-thread', userMessage: 'Inspect the page.', task: taskWithRequirements({ id: 'stuck-task', requirements: [{ id: 'page', description: 'Observe the page.', type: 'fact', mandatory: true, target: { factId: 'page' } }] }),
    });
    expect(result.status).toBe('failed');
    expect(result.run.error?.code).toBe('RECOVERY_BUDGET_EXHAUSTED');
    expect(result.run.error?.code).not.toBe('TOOL_LOOP_DETECTED');
    expect(result.run.state?.failedStrategies.length).toBeGreaterThan(0);
  });

  it('keeps an observed fact when a later worker hypothesis conflicts with it', async () => {
    const guest = new MockGuestTransport();
    const releaseUrl = 'file:///home/helm/release.html';
    const target = objective('fact', 'browser', 'Observe the release version.', 'latestReleaseVersion');
    const worker = new FunctionalWorker([async context => {
      const action = await executeAction(context, 'browser.navigate', { url: releaseUrl }, 'navigate');
      const resultEvidence = action.result.evidence;
      const evidenceId = typeof resultEvidence === 'object' && resultEvidence !== null && 'receipt' in resultEvidence
        ? (resultEvidence.receipt as { id: string }).id
        : 'missing';
      return { status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [action], facts: [fact('latestReleaseVersion', 'wrong-version', evidenceId)], evidence: [], artifacts: [], blockers: [], environmentChanged: true };
    }]);
    const result = await runtimeFor(guest, [{ type: 'objective', objective: target }], worker, { maxSteps: 2, noProgressThreshold: 1, maxRecoveryAttempts: 0 }).run({
      threadId: 'hypothesis-thread', userMessage: 'Observe the release.', task: taskWithRequirements({ id: 'hypothesis-task', requirements: [{ id: 'latestReleaseVersion', description: 'Observe version.', type: 'fact', mandatory: true, target: { factId: 'latestReleaseVersion' } }] }),
    });
    expect(result.run.state?.facts.find(item => item.id === 'latestReleaseVersion')?.origin).not.toBe('observed');
    expect(result.status).not.toBe('completed');
  });

  it('records redirected downloads as artifacts with the final URL', async () => {
    const guest = new MockGuestTransport({ downloads: { 'https://example.test/download': { filename: 'bun.tar.gz', finalUrl: 'https://cdn.example.test/bun.tar.gz', content: 'artifact' } } });
    const tools = createGuestToolRegistry(guest);
    const result = await tools.execute('browser.download', { url: 'https://example.test/download' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ sourceUrl: 'https://example.test/download', finalUrl: 'https://cdn.example.test/bun.tar.gz', savedPath: '/home/helm/Downloads/bun.tar.gz' });
    expect(result.evidence).toMatchObject({ receipt: { effect: { downloadStarted: true } } });
  });

  it('recognizes a requested file that already exists while still recording the write receipt', async () => {
    const guest = new MockGuestTransport({ initialFiles: { '/home/helm/workspace/existing.txt': 'old' } });
    const tools = createGuestToolRegistry(guest);
    const result = await tools.execute('fs.write', { path: '/home/helm/workspace/existing.txt', content: 'new' });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ existedBefore: true, path: '/home/helm/workspace/existing.txt' });
    expect(result.evidence).toMatchObject({ receipt: { effect: { existsBefore: true, existsAfter: true } } });
  });

  it('allows repeated observation calls when the browser DOM revision changes', () => {
    const first = { timestamp: 1, browser: { url: DEMO_PAGE_URL, title: 'demo', revision: 1 }, task: { completedCriteria: [], remainingCriteria: ['page'] } };
    const second = { ...first, timestamp: 2, browser: { ...first.browser, revision: 2 } };
    const state = createTaskState(taskWithRequirements());
    expect(progressFingerprint(state, first as EnvironmentObservation, objective('page', 'browser', 'Inspect page.', 'page')))
      .not.toBe(progressFingerprint(state, second as EnvironmentObservation, objective('page', 'browser', 'Inspect page.', 'page')));
  });

  it('records that a click did not navigate instead of inferring navigation', async () => {
    const guest = new MockGuestTransport({ initialFiles: { '/home/helm/click.html': '<html><body><button>Continue</button></body></html>' } });
    const tools = createGuestToolRegistry(guest);
    await tools.execute('browser.navigate', { url: 'file:///home/helm/click.html' });
    await tools.execute('browser.snapshot', {});
    const result = await tools.execute('browser.click', { ref: 'e1' });
    expect(result.evidence).toMatchObject({ receipt: { effect: { navigationOccurred: false, newTabOpened: false } } });
  });

  it('recovers with a materially different strategy and then completes', async () => {
    const guest = new MockGuestTransport();
    const first = objective('read-only', 'browser', 'Inspect the current page.', 'outputFile');
    const second = objective('write-file', 'filesystem', 'Create the required file.', 'outputFile');
    const worker = new FunctionalWorker([
      async context => {
        const action = await executeAction(context, 'browser.getState', {}, 'no-op');
        return { status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [action], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: false };
      },
      async context => {
        const action = await executeAction(context, 'fs.write', { path: '/home/helm/workspace/recovered.txt', content: 'recovered' }, 'write');
        return { status: 'completed', worker: 'filesystem', objectiveId: context.objective.id, actions: [action], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true };
      },
    ]);
    const result = await runtimeFor(guest, [
      { type: 'objective', objective: first },
      { type: 'objective', objective: second },
    ], worker, { noProgressThreshold: 1, maxRecoveryAttempts: 2, maxSteps: 4 }).run({
      threadId: 'recovery-success', userMessage: 'Recover.', task: taskWithRequirements({ id: 'recovery-success-task', requirements: [{ id: 'outputFile', description: 'Create recovered file.', type: 'filesystem', mandatory: true, target: { path: '/home/helm/workspace/recovered.txt', mode: 'exists' } }] }),
    });
    expect(result.status).toBe('completed');
    expect(result.run.state?.failedStrategies[0]?.objectiveId).toBe('read-only');
    expect(guest.hasFile('/home/helm/workspace/recovered.txt')).toBe(true);
  });

  it('lets a worker correct an assumption after reading the actual page', async () => {
    const releaseUrl = 'file:///home/helm/release.html';
    const guest = new MockGuestTransport({ initialFiles: { '/home/helm/release.html': '<html><body><h1>Latest release v9.9.9</h1></body></html>' } });
    const target = objective('release', 'browser', 'Determine the release version.', 'latestReleaseVersion');
    const worker = new FunctionalWorker([
      async context => {
        const action = await executeAction(context, 'browser.navigate', { url: releaseUrl }, 'navigate');
        const evidence = action.result.evidence as { receipt?: { id: string } };
        return { status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [action], facts: [fact('latestReleaseVersion', 'v0.0.0', evidence.receipt?.id ?? 'missing')], evidence: [], artifacts: [], blockers: [], environmentChanged: true };
      },
      async context => {
        const action = await executeAction(context, 'browser.read', { mode: 'readable' }, 'read');
        const evidence = action.result.evidence as { receipt?: { id: string } };
        return { status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [action], facts: [fact('latestReleaseVersion', 'v9.9.9', evidence.receipt?.id ?? 'missing')], evidence: [], artifacts: [], blockers: [], environmentChanged: true };
      },
    ]);
    const result = await runtimeFor(guest, [{ type: 'objective', objective: target }], worker, { maxSteps: 3, noProgressThreshold: 2, maxRecoveryAttempts: 2 }).run({
      threadId: 'assumption-thread', userMessage: `Read the release at ${releaseUrl}.`, task: taskWithRequirements({ id: 'assumption-task', requirements: [{ id: 'latestReleaseVersion', description: 'Observe version.', type: 'fact', mandatory: true, target: { factId: 'latestReleaseVersion' } }] }),
    });
    expect(result.status).toBe('completed');
    expect(result.run.state?.facts.find(item => item.id === 'latestReleaseVersion')).toMatchObject({ value: 'v9.9.9', origin: 'observed' });
  });

  it('inspects an ambiguous website flow before clicking', async () => {
    const guest = new MockGuestTransport({ initialFiles: { '/home/helm/ambiguous.html': '<html><body><button>Reveal</button></body></html>' } });
    const tools = createGuestToolRegistry(guest);
    const inspect = objective('inspect-first', 'browser', 'Inspect the ambiguous control.', 'missing');
    const click = objective('click-after-inspection', 'browser', 'Use the identified control.', 'missing');
    const worker = new FunctionalWorker([
      async context => ({ status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [await executeAction(context, 'browser.navigate', { url: 'file:///home/helm/ambiguous.html' }, 'navigate'), await executeAction(context, 'browser.snapshot', {}, 'snapshot')], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: true }),
      async context => ({ status: 'completed', worker: 'browser', objectiveId: context.objective.id, actions: [await executeAction(context, 'browser.click', { ref: 'e1' }, 'click')], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: false }),
    ]);
    const result = await new AgentRuntime({
      guestTransport: guest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(guest),
      decisionProvider: { next: async () => ({ type: 'complete' as const }) },
      orchestrator: new ScriptedOrchestratorProvider([{ type: 'objective', objective: inspect }, { type: 'objective', objective: click }]),
      worker,
      budgets: { maxSteps: 2 },
    }).run({
      threadId: 'ambiguous-thread', userMessage: 'Inspect before acting.', task: taskWithRequirements({ id: 'ambiguous-task', requirements: [{ id: 'missing', description: 'A fact that needs the revealed result.', type: 'fact', mandatory: true, target: { factId: 'missing' } }] }),
    });
    const toolNames = tools.invocations.map(invocation => invocation.tool);
    expect(toolNames.indexOf('browser.snapshot')).toBeGreaterThanOrEqual(0);
    expect(toolNames.indexOf('browser.click')).toBeGreaterThan(toolNames.indexOf('browser.snapshot'));
    expect(result.status).not.toBe('completed');
  });

  it('routes download artifacts to a browser worker', () => {
    const state = createTaskState(taskWithRequirements({
      requirements: [{ id: 'download', description: 'Download the artifact.', type: 'artifact', mandatory: true, target: { mode: 'downloaded' } }],
    }));
    const result = objectiveForRequirement(state, { timestamp: 1, task: { completedCriteria: [], remainingCriteria: ['download'] } }, 'download');
    expect(result?.kind).toBe('browser');
  });

  it('does not inspect the guest for an orchestrated conversation task', async () => {
    const guest = new MockGuestTransport();
    let observed = false;
    const result = await new AgentRuntime({
      guestTransport: guest,
      toolRegistry: createGuestToolRegistry(guest),
      verifier: new CriterionVerifierRegistry(guest),
      decisionProvider: { next: async () => ({ type: 'complete' as const }) },
      orchestrator: new ScriptedOrchestratorProvider([]),
      worker: new FunctionalWorker([]),
      observe: {
        observe: async () => {
          observed = true;
          throw new Error('conversation should not inspect the guest');
        },
      },
    }).run({
      threadId: 'conversation-thread',
      userMessage: 'Who are you?',
      task: {
        id: 'conversation-task',
        threadId: 'conversation-thread',
        goal: 'Answer directly.',
        criteria: [],
        requirements: [],
        isConversation: true,
      },
    });
    expect(result.status).toBe('completed');
    expect(observed).toBe(false);
  });
});
