import { generateText } from 'ai';
import { languageModel } from '../agent/model.ts';
import { config } from '../config.ts';
import type {
  ConversationMessageRecord,
  ConversationSummaryRecord,
} from '../contracts.ts';
import { getLatestSummary, insertSummary } from '../database/store.ts';
import { upsertMemory } from '../services/memory.ts';

const sanitizeToolPayload = (payload: Record<string, unknown>) => {
  const output =
    payload.output && typeof payload.output === 'object'
      ? { ...(payload.output as Record<string, unknown>) }
      : null;

  if (output && typeof output.imageBase64 === 'string') {
    const kb = Math.round(output.imageBase64.length / 1024);
    output.imageBase64 = `[omitted screenshot base64 (${kb}KB)]`;
  }

  if (!output) {
    return payload;
  }

  return {
    ...payload,
    output,
  };
};

const sanitizeAttachmentPayload = (payload: Record<string, unknown>) => {
  const copy = { ...payload };
  const url = typeof copy.url === 'string' ? copy.url : '';

  if (url.startsWith('data:')) {
    const kb = Math.round(url.length / 1024);
    copy.url = `[omitted data url (${kb}KB)]`;
  }

  return copy;
};

const textFromMessage = (message: ConversationMessageRecord): string =>
  message.parts
    .map((part) => {
      if (part.partType === 'text') {
        return typeof part.content.text === 'string' ? part.content.text : '';
      }

      if (part.partType === 'reasoning') {
        return typeof part.content.text === 'string'
          ? `[reasoning] ${part.content.text}`
          : '';
      }

      if (part.partType === 'attachment') {
        return `[attachment] ${JSON.stringify(
          sanitizeAttachmentPayload(part.content),
        )}`;
      }

      if (part.partType === 'tool_call') {
        return `[tool-call] ${JSON.stringify(part.content)}`;
      }

      if (part.partType === 'tool_result') {
        return `[tool-result] ${JSON.stringify(sanitizeToolPayload(part.content))}`;
      }

      return '';
    })
    .filter(Boolean)
    .join('\n');

const estimateTokens = (messages: ConversationMessageRecord[]): number => {
  const charCount = messages.reduce((total, message) => {
    return total + textFromMessage(message).length;
  }, 0);

  return Math.ceil(charCount / 4);
};

const toTranscript = (messages: ConversationMessageRecord[]): string =>
  messages
    .map((message) => {
      const content = textFromMessage(message);
      return `${message.role.toUpperCase()}:\n${content}`;
    })
    .join('\n\n');

export const maybeSummarizeConversation = async (args: {
  conversationId: string;
  messages: ConversationMessageRecord[];
}): Promise<ConversationSummaryRecord | null> => {
  const totalTokens = estimateTokens(args.messages);
  if (totalTokens <= config.SUMMARY_TRIGGER_TOKENS) {
    return null;
  }

  const latestSummary = getLatestSummary(args.conversationId);
  const summarizedUpTo = latestSummary?.upToMessageCount ?? 0;

  const keepRecent = config.SUMMARY_KEEP_RECENT_MESSAGES;
  const cutoff = Math.max(0, args.messages.length - keepRecent);

  if (cutoff <= summarizedUpTo) {
    return null;
  }

  const targetMessages = args.messages.slice(summarizedUpTo, cutoff);
  if (targetMessages.length === 0) {
    return null;
  }

  const transcript = toTranscript(targetMessages);

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
    upToMessageCount: cutoff,
    tokenEstimate: totalTokens,
  });

  await upsertMemory({
    conversationId: args.conversationId,
    entityType: 'summary',
    entityId: summary.id,
    text: summaryText,
    collectionName: config.SUMMARY_COLLECTION,
    metadata: {
      upToMessageCount: cutoff,
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

export const estimateConversationTokens = estimateTokens;
