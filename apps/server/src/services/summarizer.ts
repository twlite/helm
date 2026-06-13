import { generateText } from 'ai';
import { languageModel } from '../agent/model.ts';
import { config } from '../config.ts';
import type {
  ConversationMessageRecord,
  ConversationSummaryRecord,
} from '../contracts.ts';
import { getLatestSummary, insertSummary } from '../database/store.ts';
import { getEffectiveSummaryContext } from '../services/model-context.ts';
import { upsertMemory } from '../services/memory.ts';
import {
  buildSummarizationPlan,
  estimateConversationTokens,
  toTranscript,
} from '../services/summary-planning.ts';

export const maybeSummarizeConversation = async (args: {
  conversationId: string;
  messages: ConversationMessageRecord[];
}): Promise<ConversationSummaryRecord | null> => {
  const latestSummary = getLatestSummary(args.conversationId);
  const summaryContext = await getEffectiveSummaryContext({
    baseUrl: config.LLM_BASE_URL,
    fallbackTriggerTokens: config.SUMMARY_TRIGGER_TOKENS,
    modelId: config.VLM_MODEL,
  });
  const plan = buildSummarizationPlan({
    keepRecentMessages: config.SUMMARY_KEEP_RECENT_MESSAGES,
    latestSummary,
    messages: args.messages,
    triggerTokens: summaryContext.triggerTokens,
  });

  if (!plan) {
    return null;
  }

  const transcript = toTranscript(plan.targetMessages);

  const result = await generateText({
    model: languageModel,
    prompt: [
      'Summarize this desktop automation conversation for future context reuse.',
      'Capture: user goal, confirmed state observations, actions attempted, outcomes, and unresolved blockers.',
      'Keep it concise, factual, and implementation-oriented.',
      '',
      transcript,
    ].join('\n'),
    system:
      'You summarize automation traces. Do not invent outcomes. Preserve important constraints and failures.',
  });

  const summaryText = result.text.trim();
  if (!summaryText) {
    return null;
  }

  const summary = insertSummary({
    conversationId: args.conversationId,
    summaryText,
    upToMessageCount: plan.upToMessageCount,
    tokenEstimate: plan.tokenEstimate,
  });

  await upsertMemory({
    conversationId: args.conversationId,
    entityType: 'summary',
    entityId: summary.id,
    text: summaryText,
    collectionName: config.SUMMARY_COLLECTION,
    metadata: {
      upToMessageCount: plan.upToMessageCount,
    },
  });

  return summary;
};

export const buildSummaryContext = (
  summary: ConversationSummaryRecord | null,
): string | null => {
  if (!summary) {
    return null;
  }

  return [
    'Conversation summary (compressed memory):',
    summary.summaryText,
    `Covers first ${summary.upToMessageCount} messages.`,
  ].join('\n');
};

export { estimateConversationTokens };
