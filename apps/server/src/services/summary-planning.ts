import type {
  ConversationMessageRecord,
  ConversationSummaryRecord,
} from '../contracts.ts';

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

const estimateTextTokens = (text: string): number => Math.ceil(text.length / 4);

export const estimateConversationTokens = (
  messages: ConversationMessageRecord[],
): number => {
  const charCount = messages.reduce((total, message) => {
    return total + textFromMessage(message).length;
  }, 0);

  return Math.ceil(charCount / 4);
};

export const toTranscript = (
  messages: ConversationMessageRecord[],
): string =>
  messages
    .map((message) => {
      const content = textFromMessage(message);
      return `${message.role.toUpperCase()}:\n${content}`;
    })
    .join('\n\n');

const estimateSummaryContextTokens = (
  summary: ConversationSummaryRecord | null,
): number => {
  if (!summary) {
    return 0;
  }

  return estimateTextTokens(summary.summaryText);
};

export interface SummarizationPlan {
  targetMessages: ConversationMessageRecord[];
  tokenEstimate: number;
  upToMessageCount: number;
}

export const buildSummarizationPlan = (args: {
  keepRecentMessages: number;
  latestSummary: ConversationSummaryRecord | null;
  messages: ConversationMessageRecord[];
  triggerTokens: number;
}): SummarizationPlan | null => {
  const summarizedUpTo = args.latestSummary?.upToMessageCount ?? 0;
  const activeMessages = args.messages.slice(summarizedUpTo);
  const activeTokenEstimate =
    estimateConversationTokens(activeMessages) +
    estimateSummaryContextTokens(args.latestSummary);

  if (activeTokenEstimate <= args.triggerTokens) {
    return null;
  }

  const keepRecent = Math.max(0, args.keepRecentMessages);
  const cutoff = Math.max(0, args.messages.length - keepRecent);

  if (cutoff <= summarizedUpTo) {
    return null;
  }

  const targetMessages = args.messages.slice(summarizedUpTo, cutoff);
  if (targetMessages.length === 0) {
    return null;
  }

  return {
    targetMessages,
    tokenEstimate: activeTokenEstimate,
    upToMessageCount: cutoff,
  };
};
