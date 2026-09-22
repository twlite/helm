import { describe, expect, it } from 'bun:test';

import { assistantMessageForResult } from '../../src/agent/result-message';
import type { AgentRuntimeResult } from '../../src/agent/types';

function completedResult(steps: AgentRuntimeResult['steps']): AgentRuntimeResult {
  return {
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      goal: 'Read a page',
      status: 'completed',
      criteria: [{ type: 'browser.url', url: 'https://twlite.dev' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
    },
    task: {
      id: 'task-1',
      threadId: 'thread-1',
      goal: 'Read a page',
      criteria: [{ type: 'browser.url', url: 'https://twlite.dev' }],
    },
    history: [],
    steps,
    observations: [],
    finalVerification: {
      complete: true,
      criteria: [{
        criterion: { type: 'browser.url', url: 'https://twlite.dev' },
        passed: true,
        message: 'Browser URL is https://twlite.dev.',
      }],
      summary: '1/1 completion criteria passed.',
    },
    status: 'completed',
  };
}

describe('assistant result messages', () => {
  it('has a conversational fallback instead of exposing an empty-criteria status', () => {
    const result = completedResult([]);
    result.task.criteria = [];
    result.run.criteria = [];
    result.finalVerification = { complete: true, criteria: [], summary: 'Response ready.' };

    expect(assistantMessageForResult(result)).toContain('I’m Helm');
    expect(assistantMessageForResult(result)).not.toContain('no completion criteria');
  });

  it('surfaces extracted browser text instead of only the verification summary', () => {
    const message = assistantMessageForResult(completedResult([{
      id: 'step-1',
      runId: 'run-1',
      stepIndex: 0,
      phase: 'act',
      toolName: 'browser.extractText',
      toolInput: {},
      toolResult: {
        ok: true,
        data: {
          url: 'https://twlite.dev/',
          title: 'Twilight',
          text: 'Helm makes local computer use useful.',
        },
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:01.000Z',
    }]));

    expect(message).toContain('I read Twilight (https://twlite.dev/).');
    expect(message).toContain('Helm makes local computer use useful.');
    expect(message).not.toBe('1/1 completion criteria passed.');
  });
});
