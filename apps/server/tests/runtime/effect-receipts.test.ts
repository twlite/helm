import { describe, expect, it } from 'bun:test';

import type { ActionReceipt, CompletionCriterion, TaskDefinition, WorkerAction } from '@helm/shared';
import { createTaskState, modelActionForRequirement, taskRequirementSummary, updateCompletedRequirements, verifyTaskState } from '../../src/agent/task-state';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';

const url = 'https://fixture.example.test/rates';
const workspacePath = '/home/helm/workspace/forex.txt';

function receipt(tool: string, effect: ActionReceipt['effect'], ok = true): ActionReceipt {
  return {
    id: `receipt-${tool}`,
    tool,
    ok,
    effect,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
  };
}

function task(): TaskDefinition {
  return {
    id: 'receipt-effects',
    threadId: 'receipt-effects',
    goal: 'Fetch rates, save forex.txt, open it, and remember the source.',
    originalRequest: 'Fetch rates, save forex.txt, open it, and remember the source.',
    criteria: [],
    requirements: [
      {
        id: 'browserVisited1', description: 'Visit the requested site.', type: 'browser', mandatory: true,
        target: { url, freshness: 'current-run' },
      },
      {
        id: 'memoryMutation', description: 'Remember the requested site.', type: 'semantic', mandatory: true,
        target: {
          action: 'memory.remember', freshness: 'current-run',
        },
      },
      {
        id: 'outputFile', description: 'Write forex.txt.', type: 'filesystem', mandatory: true,
        target: { path: 'forex.txt', mode: 'non-empty', freshness: 'current-run', action: 'fs.write' },
      },
      {
        id: 'openFile', description: 'Open forex.txt in the text editor.', type: 'desktop', mandatory: true,
        target: { path: 'forex.txt', application: 'text-editor', mode: 'opened', freshness: 'current-run', action: 'app.openFile' },
      },
    ],
  };
}

function action(
  tool: string,
  input: Record<string, unknown>,
  data: Record<string, unknown> | undefined,
  actionReceipt: ActionReceipt,
): WorkerAction {
  return {
    id: actionReceipt.id,
    tool,
    input,
    result: {
      ok: actionReceipt.ok,
      ...(data ? { data } : {}),
      ...(!actionReceipt.ok ? { error: { code: 'FILE_NOT_FOUND', message: 'File does not exist.' } } : {}),
      evidence: { receipt: actionReceipt },
    },
    receipt: actionReceipt,
  };
}

describe('current-run effect receipts', () => {
  it('accepts concrete requested effects from successful receipts without contradictory live state', async () => {
    const currentTask = task();
    const state = createTaskState(currentTask);
    const guest = new MockGuestTransport();
    state.recentActions = [
      action('browser.navigate', { url }, { url }, receipt('browser.navigate', {
        requestedUrl: url,
        urlBefore: 'about:blank',
        urlAfter: url,
      })),
      action('memory.remember', {
        content: `Use ${url} for future requests.`, kind: 'instruction', source: 'user',
      }, { action: 'remembered' }, receipt('memory.remember', { changed: true })),
      action('fs.write', { path: 'forex.txt', content: 'Currency | Buy | Sell\nUSD | 153.01 | 153.61' }, {
        path: workspacePath, size: 43, sha256: 'written-content-hash',
      }, receipt('fs.write', { path: workspacePath, bytesWritten: 43, writePerformed: true })),
      action('app.openFile', { path: 'forex.txt', application: 'text-editor' }, {
        path: workspacePath, application: 'text-editor',
      }, receipt('app.openFile', { path: workspacePath, application: 'text-editor' })),
    ];

    expect(guest.hasFile(workspacePath)).toBe(false);
    const verification = await verifyTaskState(
      currentTask,
      state,
      guest,
      { timestamp: Date.now(), task: { completedCriteria: [], remainingCriteria: [] } },
      new CriterionVerifierRegistry(guest),
    );
    expect(verification.complete).toBe(true);
    expect(verification.requirements?.every(check => check.passed)).toBe(true);
    expect(updateCompletedRequirements(state, verification).completedRequirementIds).toEqual([
      'browserVisited1', 'memoryMutation', 'outputFile', 'openFile',
    ]);
  });

  it('does not accept a failed open receipt or a write receipt for the wrong path', async () => {
    const currentTask = task();
    const guest = new MockGuestTransport();
    const observation = { timestamp: Date.now(), task: { completedCriteria: [], remainingCriteria: [] } };

    const failedOpenState = createTaskState(currentTask);
    failedOpenState.recentActions = [
      action('app.openFile', { path: 'forex.txt', application: 'text-editor' }, undefined,
        receipt('app.openFile', { path: workspacePath, application: 'text-editor' }, false)),
    ];
    const failedOpen = await verifyTaskState(
      currentTask, failedOpenState, guest, observation, new CriterionVerifierRegistry(guest),
    );
    expect(failedOpen.requirements?.find(check => check.requirement.id === 'openFile')?.passed).toBe(false);

    const wrongWriteState = createTaskState(currentTask);
    wrongWriteState.recentActions = [
      action('fs.write', { path: 'forex.txt', content: 'data' }, {
        path: workspacePath, size: 4, sha256: 'wrong-path-content',
      }, receipt('fs.write', { path: '/home/helm/workspace/other.txt', bytesWritten: 4, writePerformed: true })),
    ];
    const wrongWrite = await verifyTaskState(
      currentTask, wrongWriteState, guest, observation, new CriterionVerifierRegistry(guest),
    );
    expect(wrongWrite.requirements?.find(check => check.requirement.id === 'outputFile')?.passed).toBe(false);
  });

  it('requires a browser-derived output write to use the observed durable artifact', async () => {
    const baseTask = task();
    const rawTask: TaskDefinition = {
      ...baseTask,
      requirements: baseTask.requirements?.map(requirement => requirement.id === 'outputFile'
        ? { ...requirement, target: { ...requirement.target, mode: 'written-from-artifact', sourceUrls: [url] } }
        : requirement),
    };
    const contentRef = 'c3-12345678-1';
    const documentRef = 'd3-12345678-1';
    const capturedAt = new Date(1).toISOString();
    const readData = {
      operation: 'read', url, revision: 3, readable: true, sourceTruncated: false,
      sourceCapturedAt: capturedAt, sourceStructuredBlockCount: 1, sourceTableCount: 1,
      documentRef, sourceRefs: [contentRef],
      blocks: [{ ref: contentRef, type: 'table', columns: ['Currency'], rows: [['USD']], rowCount: 1 }],
      diagnostics: {
        sourceTruncated: false, documentBlockCount: 1, documentStructuredBlockCount: 1, documentTableCount: 1,
        documentSourceRefs: [{ ref: contentRef, type: 'table', includedInDocument: true }],
      },
    };
    const validWriteData = {
      path: workspacePath, size: 24, sourceRef: documentRef, sourceType: 'document',
      sourceRevision: 3, sourceUrl: url, sourceCapturedAt: capturedAt, sourceRefs: [contentRef],
      sourceStructuredBlockCount: 1, sourceTableCount: 1, sourceTruncated: false,
    };
    const guest = new MockGuestTransport();
    const observation = { timestamp: Date.now(), task: { completedCriteria: [], remainingCriteria: [] } };

    const unrelatedState = createTaskState(rawTask);
    unrelatedState.recentActions = [
      action('browser.read', { mode: 'document' }, readData, receipt('browser.read', {})),
      action('fs.writeText', { path: 'forex.txt', content: 'some unrelated non-empty text' }, {
        path: workspacePath, size: 29,
      }, receipt('fs.write', { path: workspacePath, bytesWritten: 29, writePerformed: true })),
    ];
    const unrelated = await verifyTaskState(rawTask, unrelatedState, guest, observation, new CriterionVerifierRegistry(guest));
    const rejected = unrelated.requirements?.find(check => check.requirement.id === 'outputFile');
    expect(rejected).toMatchObject({
      passed: false,
      reasonCode: 'BROWSER_PROVENANCE_REQUIRED',
      correctiveTool: 'fs.writeFromRef',
      rejectedAction: { tool: 'fs.writeText', path: 'forex.txt' },
      correctiveArtifact: {
        sourceRef: documentRef,
        sourceType: 'document',
        sourceUrl: url,
        sourceTableCount: 1,
        complete: true,
      },
    });
    expect(rejected?.message).toContain('fs.writeFromRef with that sourceRef to overwrite forex.txt');
    expect(rejected?.evidence).toMatchObject({ rejectedAction: { tool: 'fs.writeText' } });

    const artifactState = createTaskState(rawTask);
    artifactState.recentActions = [
      action('browser.read', { mode: 'document' }, readData, receipt('browser.read', {})),
      action('fs.writeFromRef', { path: 'forex.txt', sourceRef: documentRef, format: 'text' }, validWriteData,
        receipt('fs.write', { path: workspacePath, bytesWritten: 24, writePerformed: true })),
    ];
    const artifact = await verifyTaskState(rawTask, artifactState, guest, observation, new CriterionVerifierRegistry(guest));
    expect(artifact.requirements?.find(check => check.requirement.id === 'outputFile')?.passed).toBe(true);

    const wrongSourceState = createTaskState(rawTask);
    wrongSourceState.recentActions = [
      action('browser.read', { mode: 'document' }, readData, receipt('browser.read', {})),
      action('fs.writeFromRef', { path: 'forex.txt', sourceRef: documentRef, format: 'text' }, {
        ...validWriteData, sourceUrl: 'https://unrelated.example.test/rates',
      }, receipt('fs.write', { path: workspacePath, bytesWritten: 24, writePerformed: true })),
    ];
    const wrongSource = await verifyTaskState(rawTask, wrongSourceState, guest, observation, new CriterionVerifierRegistry(guest));
    expect(wrongSource.requirements?.find(check => check.requirement.id === 'outputFile')).toMatchObject({
      passed: false,
      reasonCode: 'SOURCE_URL_MISMATCH',
      correctiveTool: 'fs.writeFromRef',
      rejectedAction: { tool: 'fs.writeFromRef', sourceUrl: 'https://unrelated.example.test/rates' },
    });
  });

  it('shows model-visible write tools in requirement summaries and hides the internal receipt action', () => {
    const baseTask = task();
    const rawRequirement = {
      ...baseTask.requirements![2]!,
      target: { ...baseTask.requirements![2]!.target, mode: 'written-from-artifact' as const, action: 'fs.write' as const, sourceUrls: [url] },
    };
    const authoredRequirement = {
      ...baseTask.requirements![2]!,
      target: { ...baseTask.requirements![2]!.target, mode: 'written' as const, action: 'fs.write' as const },
    };
    expect(modelActionForRequirement(rawRequirement)).toBe('fs.writeFromRef');
    expect(modelActionForRequirement(authoredRequirement)).toBe('fs.writeText');

    const state = createTaskState({ ...baseTask, requirements: [rawRequirement] });
    const summary = taskRequirementSummary(state);
    expect(summary).toContain('mode=written-from-artifact');
    expect(summary).toContain('action=fs.writeFromRef');
    expect(summary).toContain(`sourceUrl=${url}`);
    expect(summary).not.toContain('action=fs.write ');

    const visibleNames = createGuestToolRegistry(new MockGuestTransport()).list().map(tool => tool.name);
    expect(visibleNames).toContain('fs.writeFromRef');
    expect(visibleNames).toContain('fs.writeText');
    expect(visibleNames).not.toContain('fs.write');
  });

  it('does not let a pre-existing browser URL satisfy a requested visit without a navigation receipt', async () => {
    const criterion: CompletionCriterion = { type: 'browser.url', url };
    const currentTask: TaskDefinition = {
      id: 'browser-visit-receipt',
      threadId: 'browser-visit-receipt',
      goal: 'Visit the requested page.',
      criteria: [criterion],
      requirements: [],
    };
    const state = createTaskState(currentTask);
    const guest = new MockGuestTransport();
    const observation = {
      timestamp: Date.now(),
      browser: { url },
      task: { completedCriteria: [], remainingCriteria: [] },
    };

    const withoutReceipt = await verifyTaskState(
      currentTask, state, guest, observation, new CriterionVerifierRegistry(guest),
    );
    expect(withoutReceipt.complete).toBe(false);
    expect(withoutReceipt.criteria[0]?.passed).toBe(false);

    state.recentActions = [action('browser.read', {}, {
      operation: 'read', url, title: 'Rates', revision: 1, readable: true,
      blocks: [{ ref: 'c1-12345678-1', type: 'text', text: 'Observed rate data.' }],
    }, receipt('browser.read', {}))];
    const readEvidence = await verifyTaskState(
      currentTask, state, guest, observation, new CriterionVerifierRegistry(guest),
    );
    expect(readEvidence.complete).toBe(true);
    expect(readEvidence.criteria[0]?.passed).toBe(true);

    const unrelatedCurrentPage = await verifyTaskState(
      currentTask,
      state,
      guest,
      { ...observation, browser: { url: 'https://unrelated.example.test/' } },
      new CriterionVerifierRegistry(guest),
    );
    expect(unrelatedCurrentPage.complete).toBe(false);
    expect(unrelatedCurrentPage.criteria[0]?.passed).toBe(false);

    const finalUrl = 'https://rates-cdn.example.test/current';
    state.recentActions = [
      action('browser.navigate', { url }, undefined, receipt('browser.navigate', {
        requestedUrl: url,
        urlBefore: 'about:blank',
        urlAfter: finalUrl,
        navigationOccurred: true,
      }, false)),
      action('browser.read', {}, {
        operation: 'read', url: finalUrl, title: 'Rates', revision: 2, readable: true,
        blocks: [{ ref: 'c2-12345678-1', type: 'text', text: 'Observed rate data.' }],
      }, receipt('browser.read', {})),
    ];
    const redirectedReadEvidence = await verifyTaskState(
      currentTask,
      state,
      guest,
      { ...observation, browser: { url: finalUrl } },
      new CriterionVerifierRegistry(guest),
    );
    expect(redirectedReadEvidence.complete).toBe(true);
    expect(redirectedReadEvidence.criteria[0]?.passed).toBe(true);

    state.recentActions = [action('browser.navigate', { url }, { url }, receipt('browser.navigate', {
      requestedUrl: url,
      urlBefore: 'about:blank',
      urlAfter: url,
    }))];
    const withReceipt = await verifyTaskState(
      currentTask, state, guest, observation, new CriterionVerifierRegistry(guest),
    );
    expect(withReceipt.complete).toBe(true);
    expect(withReceipt.criteria[0]?.passed).toBe(true);
  });
});
