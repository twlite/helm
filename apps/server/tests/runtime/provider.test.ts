import { describe, expect, it } from 'bun:test';

import { ScriptedDecisionProvider, resolvePriorResultReference } from '../../src/agent/planner';

describe('ScriptedDecisionProvider', () => {
  it('chains a prior tool result into a later action input', async () => {
    const provider = new ScriptedDecisionProvider([
      {
        type: 'action',
        tool: 'fs.write',
        input: {
          path: '/home/helm/workspace/result.txt',
          content: { fromStep: 1, path: 'data.text' },
        },
      },
    ]);

    const decision = await provider.next({
      task: { id: 'task', threadId: 'thread', goal: 'test', criteria: [] },
      observation: { timestamp: 1, task: { completedCriteria: [], remainingCriteria: [] } },
      history: [],
      memories: [],
      stepIndex: 1,
      previousResults: [{ ok: true, data: { text: 'extracted from browser' } }],
    });

    expect(decision).toEqual({
      type: 'action',
      tool: 'fs.write',
      input: {
        path: '/home/helm/workspace/result.txt',
        content: 'extracted from browser',
      },
    });
  });

  it('supports the latest-result shorthand and rejects missing references', () => {
    expect(resolvePriorResultReference(
      { fromStep: 'last', path: 'data.value' },
      [{ ok: true, data: { value: 7 } }],
    )).toBe(7);
    expect(() => resolvePriorResultReference({ fromStep: 2 }, [{ ok: true }])).toThrow();
  });
});

