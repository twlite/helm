import { describe, expect, it } from 'bun:test';

import type { ActionReceipt, TaskDefinition, WorkerAction } from '@helm/shared';
import { createTaskState, updateCompletedRequirements, verifyTaskState } from '../../src/agent/task-state';
import { MemoryService } from '../../src/memory/service';
import { registerMemoryTools } from '../../src/memory/tools';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { ToolRegistry } from '../../src/tools/tool-registry';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import { testDatabase } from '../persistence/helpers';

describe('explicit memory requirement verification', () => {
  it('satisfies memoryMutation immediately from a successful memory.remember receipt', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const tools = new ToolRegistry();
      registerMemoryTools(tools, memory);
      const task: TaskDefinition = {
        id: 'forex-memory-verification',
        threadId: 'forex-memory-verification',
        goal: 'Remember to use that site for future requests.',
        originalRequest: 'Remember to use that site for future requests.',
        criteria: [],
        requirements: [{
          id: 'memoryMutation',
          description: 'Persist the explicit user instruction.',
          type: 'semantic',
          mandatory: true,
          target: {
            action: 'memory.remember',
            freshness: 'current-run',
          },
        }],
      };
      const state = createTaskState(task);
      const guest = new MockGuestTransport();
      const observation = {
        timestamp: Date.now(),
        task: { completedCriteria: [], remainingCriteria: ['memoryMutation'] },
      };

      const recordMemoryAction = async (content: string): Promise<WorkerAction> => {
        const input = { content, kind: 'instruction' as const, source: 'user' as const };
        const result = await tools.execute('memory.remember', input);
        const receipt: ActionReceipt = {
          id: `receipt-${content.length}`,
          tool: 'memory.remember',
          ok: result.ok,
          effect: { changed: result.ok },
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        return {
          id: receipt.id,
          tool: 'memory.remember',
          input,
          result: {
            ok: result.ok,
            data: { action: 'remembered' },
            evidence: { receipt },
          },
          receipt,
        };
      };

      state.recentActions = [await recordMemoryAction('Use https://www.nrb.org.np/forex/ for future Nepal forex requests.')];
      const verification = await verifyTaskState(
        task,
        state,
        guest,
        observation,
        new CriterionVerifierRegistry(guest),
      );
      expect(verification.complete).toBe(true);
      expect(verification.requirements?.[0]).toMatchObject({
        requirement: { id: 'memoryMutation' },
        passed: true,
      });
      const updated = updateCompletedRequirements(state, verification);
      expect(updated.completedRequirementIds).toContain('memoryMutation');
    } finally {
      persistence.close();
    }
  });
});
