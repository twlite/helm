import { describe, expect, it } from 'bun:test';

import { stableStringify } from '../../src/db/json';
import { createTaskState } from '../../src/agent/task-state';
import { testDatabase } from './helpers';

describe('typed repositories', () => {
  it('round-trips threads, messages, runs, and operational steps as shared types', () => {
    const persistence = testDatabase();
    try {
      const thread = persistence.threads.create({
        id: 'thread-1',
        title: 'Persistence',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      });
      const message = persistence.messages.create({
        id: 'message-1',
        threadId: thread.id,
        role: 'user',
        content: 'Remember this',
        metadata: { z: true, nested: { b: 2, a: 1 } },
        createdAt: '2026-01-01T00:00:01.000Z',
      });
      const run = persistence.runs.create({
        id: 'run-1',
        threadId: thread.id,
        sourceMessageId: message.id,
        goal: 'Persist the trace',
        criteria: [{ type: 'file.exists', path: '/home/helm/workspace/demo.txt' }],
      });
      const step = persistence.runSteps.create({
        id: 'step-1',
        runId: run.id,
        phase: 'act',
        decision: {
          type: 'action',
          tool: 'fs.write',
          input: { path: '/home/helm/workspace/demo.txt' },
          reasoningSummary: 'Write the observed content',
        },
        toolName: 'fs.write',
        toolInput: { path: '/home/helm/workspace/demo.txt' },
        toolResult: { ok: true, data: { bytes: 12 } },
        observation: { task: { remainingCriteria: [], completedCriteria: ['file.exists'] } },
        createdAt: '2026-01-01T00:00:02.000Z',
        completedAt: '2026-01-01T00:00:03.000Z',
      });

      expect(persistence.messages.getById(message.id)).toEqual(message);
      expect(persistence.messages.listByThread(thread.id)).toEqual([message]);
      expect(persistence.runs.getById(run.id)).toEqual(run);
      expect(persistence.runSteps.getById(step.id)).toEqual(step);
      expect(persistence.runSteps.listByRun(run.id)).toEqual([step]);
      expect(
        persistence.sqlite.prepare('SELECT metadata_json FROM messages WHERE id = ?').get(message.id),
      ).toEqual({ metadata_json: '{"nested":{"a":1,"b":2},"z":true}' });
    } finally {
      persistence.close();
    }
  });

  it('round-trips compiled task state and orchestrator observability fields', () => {
    const persistence = testDatabase();
    try {
      const thread = persistence.threads.create({ title: 'Orchestration state' });
      const task = {
        id: 'compiled-task',
        threadId: thread.id,
        goal: 'Persist state',
        originalRequest: 'Persist the observed state.',
        criteria: [],
        requirements: [{ id: 'file', description: 'Create a file.', type: 'filesystem' as const, mandatory: true, status: 'pending' as const, target: { path: '/home/helm/workspace/state.txt', mode: 'exists' as const } }],
      };
      const state = createTaskState(task, () => Date.parse('2026-01-01T00:00:00.000Z'));
      const run = persistence.runs.create({ id: 'state-run', threadId: thread.id, goal: task.goal, criteria: [], task, state });
      const objective = { id: 'objective-file', kind: 'filesystem' as const, description: 'Create a file.', requirementIds: ['file'], rationale: 'required' };
      const step = persistence.runSteps.create({
        id: 'state-step', runId: run.id, phase: 'act', objective, worker: 'filesystem',
        orchestratorDecision: { type: 'objective', objective },
        workerResult: { status: 'completed', worker: 'filesystem', objectiveId: objective.id, actions: [], facts: [], evidence: [], artifacts: [], blockers: [], environmentChanged: false },
        progress: state.progress,
      });
      expect(persistence.runs.getById(run.id)).toEqual(run);
      expect(persistence.runSteps.getById(step.id)).toEqual(step);
    } finally {
      persistence.close();
    }
  });

  it('enforces explicit run state transitions and records terminal timestamps', () => {
    const persistence = testDatabase();
    try {
      const thread = persistence.threads.create({ title: 'Run states' });
      const run = persistence.runs.create({ threadId: thread.id, goal: 'state', criteria: [] });

      expect(persistence.runs.start(run.id)?.status).toBe('running');
      expect(persistence.runs.complete(run.id)?.status).toBe('completed');
      const completed = persistence.runs.getById(run.id);
      expect(completed?.startedAt).toBeDefined();
      expect(completed?.completedAt).toBeDefined();
      expect(() => persistence.runs.cancel(run.id)).toThrow(/Cannot transition/);
    } finally {
      persistence.close();
    }
  });

  it('uses stable JSON for equivalent object insertion order', () => {
    expect(stableStringify({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });
});
