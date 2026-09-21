import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { AgentRuntime } from '../../src/agent/runtime';
import { LoopDetector } from '../../src/agent/fingerprint';
import { ScriptedDecisionProvider } from '../../src/agent/planner';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import {
  DEMO_PAGE_URL,
  MockGuestTransport,
} from '../../src/tools/mock-guest-transport';
import { createScriptedDemo } from '../../src/agent/demo';
import { ToolRegistry } from '../../src/tools/tool-registry';

describe('AgentRuntime', () => {
  it('completes the scripted demo only after final verification passes', async () => {
    const demo = createScriptedDemo();
    const result = await demo.runtime.run(demo.task);

    expect(result.status).toBe('completed');
    expect(result.finalVerification?.complete).toBe(true);
    expect(demo.guest.getFile('/home/helm/workspace/demo.txt')).toBe(
      'Helm deterministic demo Helm deterministic demo content.',
    );
    const write = demo.tools.invocations.find(invocation => invocation.tool === 'fs.write');
    expect(write?.input).toEqual({
      path: '/home/helm/workspace/demo.txt',
      content: 'Helm deterministic demo Helm deterministic demo content.',
    });
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
