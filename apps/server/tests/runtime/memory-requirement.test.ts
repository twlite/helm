import { describe, expect, it } from 'bun:test';

import type { ActionReceipt, TaskDefinition, WorkerAction } from '@helm/shared';
import { createTaskState, verifyTaskState } from '../../src/agent/task-state';
import { MemoryService } from '../../src/memory/service';
import { registerMemoryTools } from '../../src/memory/tools';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { ToolRegistry } from '../../src/tools/tool-registry';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';
import { testDatabase } from '../persistence/helpers';

const expectedContent = 'Use https://www.nrb.org.np/forex/ for all forex requests about Nepal.';

describe('explicit memory requirement verification', () => {
  it('rejects an unrelated remembered value even when memory.remember succeeds', async () => {
    const persistence = testDatabase();
    try {
      const memory = new MemoryService(persistence.sqlite);
      const tools = new ToolRegistry();
      registerMemoryTools(tools, memory);
      const task: TaskDefinition = {
        id: 'forex-memory-verification',
        threadId: 'forex-memory-verification',
        goal: `Remember to ${expectedContent}`,
        originalRequest: `Remember to ${expectedContent}`,
        criteria: [],
        requirements: [{
          id: 'memoryMutation',
          description: 'Persist the explicit user instruction.',
          type: 'semantic',
          mandatory: true,
          target: {
            action: 'memory.remember',
            freshness: 'current-run',
            memoryContent: expectedContent,
            memoryKind: 'instruction',
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
          id: `receipt-${content === expectedContent ? 'expected' : 'unrelated'}`,
          tool: 'memory.remember',
          ok: result.ok,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
        return {
          id: receipt.id,
          tool: 'memory.remember',
          input,
          result: {
            ...result,
            evidence: { receipt },
          },
          receipt,
        };
      };

      state.recentActions = [await recordMemoryAction('Use a different forex website for Nepal.')];
      const unrelatedVerification = await verifyTaskState(
        task,
        state,
        guest,
        observation,
        new CriterionVerifierRegistry(guest),
      );
      expect(unrelatedVerification.complete).toBe(false);
      expect(unrelatedVerification.requirements?.[0]).toMatchObject({
        requirement: { id: 'memoryMutation' },
        passed: false,
      });

      state.recentActions = [await recordMemoryAction(expectedContent)];
      const expectedVerification = await verifyTaskState(
        task,
        state,
        guest,
        observation,
        new CriterionVerifierRegistry(guest),
      );
      expect(expectedVerification.complete).toBe(true);
      expect(expectedVerification.requirements?.[0]).toMatchObject({
        requirement: { id: 'memoryMutation' },
        passed: true,
      });
    } finally {
      persistence.close();
    }
  });
});
