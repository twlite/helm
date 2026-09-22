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
      { type: 'action', tool: 'browser.extractText', input: {} },
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
      goal: 'Read the page after navigating to it.',
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.status).toBe('completed');
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.extractText')).toBe(true);
  });

  it('does not complete a page-information task from URL verification alone', async () => {
    const guest = new MockGuestTransport();
    const tools = createGuestToolRegistry(guest);
    const verifier = new CriterionVerifierRegistry(guest);
    const provider = new ScriptedDecisionProvider([
      { type: 'action', tool: 'browser.navigate', input: { url: 'https://twlite.dev' } },
      { type: 'complete' },
      { type: 'action', tool: 'browser.extractText', input: {} },
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
      goal: 'Visit the page and extract information from it.',
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.status).toBe('completed');
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.extractText')).toBe(true);
  });

  it('automatically reads an open page when the model completes before extracting it', async () => {
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
    expect(result.steps.some(step => step.phase === 'act' && step.toolName === 'browser.extractText')).toBe(true);
    expect(result.steps.filter(step => step.phase === 'act' && step.toolName === 'browser.navigate')).toHaveLength(1);
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
