import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ConversationMessageRecord } from '../contracts.ts';
import { buildSummarizationPlan } from './summary-planning.ts';

const message = (text: string, index: number): ConversationMessageRecord => ({
  conversationId: 'conversation-1',
  createdAt: new Date(index).toISOString(),
  id: `message-${index}`,
  parts: [
    {
      content: { text },
      conversationId: 'conversation-1',
      createdAt: new Date(index).toISOString(),
      id: `part-${index}`,
      messageId: `message-${index}`,
      partType: 'text',
      position: 0,
    },
  ],
  role: index % 2 === 0 ? 'user' : 'assistant',
  runId: null,
});

describe('summary planning', () => {
  it('does not summarize below the effective context threshold', () => {
    const messages = [message('short message', 1)];

    const plan = buildSummarizationPlan({
      keepRecentMessages: 0,
      latestSummary: null,
      messages,
      triggerTokens: 100,
    });

    assert.equal(plan, null);
  });

  it('summarizes only unsummarized messages once active context reaches the threshold', () => {
    const messages = [
      message('already summarized '.repeat(120), 1),
      message('already summarized '.repeat(120), 2),
      message('new content '.repeat(120), 3),
      message('new content '.repeat(120), 4),
      message('keep recent '.repeat(20), 5),
    ];

    const plan = buildSummarizationPlan({
      keepRecentMessages: 1,
      latestSummary: {
        conversationId: 'conversation-1',
        createdAt: '2026-06-13T00:00:00.000Z',
        id: 'summary-1',
        summaryText: 'Previous summary.',
        tokenEstimate: 1200,
        upToMessageCount: 2,
      },
      messages,
      triggerTokens: 200,
    });

    assert.ok(plan);
    assert.equal(plan.upToMessageCount, 4);
    assert.deepEqual(
      plan.targetMessages.map((item) => item.id),
      ['message-3', 'message-4'],
    );
    assert.ok(plan.tokenEstimate > 200);
  });
});
