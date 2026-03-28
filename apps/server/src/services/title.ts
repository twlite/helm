import { generateText } from 'ai';
import { languageModel } from '../agent/model.ts';

const MAX_TITLE_LENGTH = 72;

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const sanitizeTitle = (value: string): string => {
  const singleLine = normalizeWhitespace(value.split('\n')[0] ?? '');
  const withoutQuotes = singleLine.replace(/^['"`]+|['"`]+$/g, '').trim();
  const collapsedPunctuation = withoutQuotes.replace(/[.!?]+$/g, '').trim();

  if (!collapsedPunctuation) {
    return '';
  }

  return collapsedPunctuation.slice(0, MAX_TITLE_LENGTH).trim();
};

const buildFallbackTitle = (args: {
  userInput: string;
  attachments: Array<{ filename: string }>;
}): string => {
  const seed =
    args.userInput.trim() ||
    args.attachments[0]?.filename?.trim() ||
    'Desktop automation task';

  return sanitizeTitle(seed) || 'Desktop automation task';
};

export const generateConversationTitle = async (args: {
  userInput: string;
  attachments: Array<{ filename: string; mediaType: string }>;
}): Promise<string> => {
  const fallback = buildFallbackTitle({
    attachments: args.attachments,
    userInput: args.userInput,
  });

  const prompt = [
    'Generate a concise conversation title for a desktop automation task.',
    'Use 3-8 words, plain language, and no quotation marks.',
    'Keep it specific to the user objective and under 72 characters.',
    'Return only the title text.',
    '',
    `User objective: ${args.userInput || '(none)'}`,
    args.attachments.length > 0
      ? `Attachments: ${args.attachments
          .map(
            (attachment) => `${attachment.filename} (${attachment.mediaType})`,
          )
          .join(', ')}`
      : 'Attachments: none',
  ].join('\n');

  try {
    const result = await generateText({
      model: languageModel,
      prompt,
      system:
        'You create short chat titles for automation sessions. Be factual, concise, and avoid punctuation noise.',
    });

    const title = sanitizeTitle(result.text);
    return title || fallback;
  } catch {
    return fallback;
  }
};
