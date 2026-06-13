import type {
  ConversationMessageRecord,
  ConversationSummaryRecord,
} from '../contracts.ts';
import { estimateConversationTokens } from './summary-planning.ts';

export interface ContextSummaryStats {
  activeMessageCount: number;
  activeTokenEstimate: number;
  compressionPercent: number;
  contextWindowTokens: number | null;
  latestSummaryTokenEstimate: number | null;
  source: 'provider' | 'fallback';
  summarizedMessageCount: number;
  summarizedTokenEstimate: number;
  summaryCount: number;
  summaryTokenEstimate: number;
  totalMessageCount: number;
  triggerTokens: number;
  usagePercent: number;
}

const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4);

const percent = (value: number, total: number): number => {
  if (total <= 0) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round((value / total) * 100)));
};

export const buildContextSummaryStats = (args: {
  contextWindowTokens: number | null;
  messages: ConversationMessageRecord[];
  source: 'provider' | 'fallback';
  summaries: ConversationSummaryRecord[];
  triggerTokens: number;
}): ContextSummaryStats => {
  const latestSummary = args.summaries.at(-1) ?? null;
  const summarizedMessageCount = latestSummary?.upToMessageCount ?? 0;
  const activeMessages = args.messages.slice(summarizedMessageCount);
  const activeTokenEstimate = estimateConversationTokens(activeMessages);
  const summaryTokenEstimate = args.summaries.reduce(
    (total, summary) => total + estimateTextTokens(summary.summaryText),
    0,
  );
  const summarizedTokenEstimate = args.summaries.reduce(
    (total, summary) => total + summary.tokenEstimate,
    0,
  );
  const budget = args.contextWindowTokens ?? args.triggerTokens;

  return {
    activeMessageCount: activeMessages.length,
    activeTokenEstimate,
    compressionPercent: percent(summarizedMessageCount, args.messages.length),
    contextWindowTokens: args.contextWindowTokens,
    latestSummaryTokenEstimate: latestSummary
      ? estimateTextTokens(latestSummary.summaryText)
      : null,
    source: args.source,
    summarizedMessageCount,
    summarizedTokenEstimate,
    summaryCount: args.summaries.length,
    summaryTokenEstimate,
    totalMessageCount: args.messages.length,
    triggerTokens: args.triggerTokens,
    usagePercent: percent(activeTokenEstimate + summaryTokenEstimate, budget),
  };
};
