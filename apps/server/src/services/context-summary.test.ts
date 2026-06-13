import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  ConversationMessageRecord,
  ConversationSummaryRecord,
} from '../contracts.ts';
import { buildContextSummaryStats } from './context-summary.ts';

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

const summary = (
  upToMessageCount: number,
  tokenEstimate: number,
  index: number,
): ConversationSummaryRecord => ({
  conversationId: 'conversation-1',
  createdAt: new Date(index).toISOString(),
  id: `summary-${index}`,
  summaryText: 'Compressed summary text.',
  tokenEstimate,
  upToMessageCount,
});

describe('context summary stats', () => {
  it('builds hover-card metrics from summary history and active messages', () => {
    const stats = buildContextSummaryStats({
      contextWindowTokens: 1000,
      messages: [
        message('old '.repeat(100), 1),
        message('old '.repeat(100), 2),
        message('active '.repeat(50), 3),
        message('active '.repeat(50), 4),
      ],
      source: 'provider',
      summaries: [summary(2, 500, 1)],
      triggerTokens: 800,
    });

    assert.equal(stats.totalMessageCount, 4);
    assert.equal(stats.summarizedMessageCount, 2);
    assert.equal(stats.activeMessageCount, 2);
    assert.equal(stats.compressionPercent, 50);
    assert.equal(stats.summaryCount, 1);
    assert.equal(stats.summarizedTokenEstimate, 500);
    assert.equal(stats.contextWindowTokens, 1000);
    assert.equal(stats.triggerTokens, 800);
    assert.equal(stats.source, 'provider');
    assert.ok(stats.activeTokenEstimate > 0);
    assert.ok(stats.summaryTokenEstimate > 0);
    assert.ok(stats.usagePercent > 0);
  });
});
