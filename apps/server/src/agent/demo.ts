import type { TaskDefinition } from '@helm/shared';

import { CriterionVerifierRegistry } from '../tools/criterion-verifier';
import { DEMO_PAGE_PATH, DEMO_PAGE_TEXT, DEMO_PAGE_URL, MockGuestTransport } from '../tools/mock-guest-transport';
import { createGuestToolRegistry } from '../tools/guest-tools';
import { AgentRuntime } from './runtime';
import { ScriptedDecisionProvider, ScriptedTaskPlanner, type ScriptedDecision } from './planner';

export const DEMO_OUTPUT_PATH = '/home/helm/workspace/demo.txt';

export function createScriptedDemoTask(threadId = 'demo-thread'): TaskDefinition {
  return {
    id: 'scripted-demo',
    threadId,
    goal: `Open ${DEMO_PAGE_URL}, save its readable contents to ${DEMO_OUTPUT_PATH}, and open the file in the text editor.`,
    criteria: [
      { type: 'browser.url', url: DEMO_PAGE_URL },
      { type: 'file.exists', path: DEMO_OUTPUT_PATH },
      { type: 'file.contains', path: DEMO_OUTPUT_PATH, expected: DEMO_PAGE_TEXT },
      { type: 'window.open', application: 'text-editor', titleIncludes: 'demo.txt' },
      { type: 'window.focused', application: 'text-editor', titleIncludes: 'demo.txt' },
    ],
  };
}

/** The write content is a prior-result reference, never a copied fixture string. */
export function createScriptedDemoDecisions(): ScriptedDecision[] {
  return [
    {
      type: 'action',
      tool: 'browser.navigate',
      input: { url: DEMO_PAGE_URL },
      reasoningSummary: 'Open the local deterministic demo page.',
    },
    {
      type: 'action',
      tool: 'browser.read',
      input: { query: 'Helm deterministic demo content' },
      reasoningSummary: 'Locate the requested text in the semantic page content.',
    },
    {
      type: 'action',
      tool: 'fs.write',
      input: {
        path: DEMO_OUTPUT_PATH,
        sourceRef: { fromStep: 2, path: 'data.blocks.0.ref' },
        format: 'text',
      },
      reasoningSummary: 'Persist the complete selected browser content block in the requested workspace file.',
    },
    {
      type: 'action',
      tool: 'fs.exists',
      input: { path: DEMO_OUTPUT_PATH },
      reasoningSummary: 'Check the file before opening it.',
    },
    {
      type: 'action',
      tool: 'app.openFile',
      input: { path: DEMO_OUTPUT_PATH, application: 'text-editor' },
      reasoningSummary: 'Open the generated file in the text editor.',
    },
    {
      type: 'action',
      tool: 'desktop.getState',
      input: {},
      reasoningSummary: 'Observe the focused text-editor window.',
    },
    {
      type: 'complete',
      reasoningSummary: 'Request completion after all explicit criteria have been observed.',
    },
  ];
}

export interface ScriptedDemo {
  guest: MockGuestTransport;
  tools: ReturnType<typeof createGuestToolRegistry>;
  verifier: CriterionVerifierRegistry;
  planner: ScriptedTaskPlanner;
  provider: ScriptedDecisionProvider;
  runtime: AgentRuntime;
  task: TaskDefinition;
}

export function createScriptedDemo(threadId = 'demo-thread'): ScriptedDemo {
  const guest = new MockGuestTransport();
  const tools = createGuestToolRegistry(guest);
  const verifier = new CriterionVerifierRegistry(guest);
  const task = createScriptedDemoTask(threadId);
  const planner = new ScriptedTaskPlanner(task);
  const provider = new ScriptedDecisionProvider(createScriptedDemoDecisions());
  const runtime = new AgentRuntime({
    guestTransport: guest,
    toolRegistry: tools,
    verifier,
    decisionProvider: provider,
    taskPlanner: planner,
  });
  return { guest, tools, verifier, planner, provider, runtime, task };
}

export { DEMO_PAGE_PATH, DEMO_PAGE_TEXT, DEMO_PAGE_URL };
