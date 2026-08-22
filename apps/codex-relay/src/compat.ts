export type RelayInputPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      url: string;
    };

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayValidationError';
  }
}

type RecordValue = Record<string, unknown>;

type ParsedMessage = {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string | ParsedContentPart[];
};

type ParsedContentPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image_url';
      image_url: {
        url: string;
      };
    };

export type ParsedChatCompletionRequest = {
  developerInstructions?: string;
  input: RelayInputPart[];
  model: string;
  stream: boolean;
};

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const parseContentPart = (value: unknown, index: number): ParsedContentPart => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new RelayValidationError(
      `messages content part ${index} must have a supported type.`,
    );
  }

  if (value.type === 'text') {
    if (typeof value.text !== 'string') {
      throw new RelayValidationError(
        `messages content part ${index} text must be a string.`,
      );
    }

    return { text: value.text, type: 'text' };
  }

  if (value.type === 'image_url') {
    if (!isRecord(value.image_url) || typeof value.image_url.url !== 'string') {
      throw new RelayValidationError(
        `messages content part ${index} image_url.url must be a string.`,
      );
    }

    const url = value.image_url.url;

    if (!url.toLowerCase().startsWith('data:image/')) {
      throw new RelayValidationError(
        'Relay accepts images as data:image/... URLs only.',
      );
    }

    return { image_url: { url }, type: 'image_url' };
  }

  throw new RelayValidationError(
    `Unsupported messages content type: ${value.type}.`,
  );
};

const parseMessage = (value: unknown, index: number): ParsedMessage => {
  if (!isRecord(value)) {
    throw new RelayValidationError(`messages[${index}] must be an object.`);
  }

  const role = value.role;

  if (
    role !== 'system' &&
    role !== 'developer' &&
    role !== 'user' &&
    role !== 'assistant'
  ) {
    throw new RelayValidationError(
      `messages[${index}].role must be system, developer, user, or assistant.`,
    );
  }

  if (typeof value.content === 'string') {
    return { content: value.content, role };
  }

  if (!Array.isArray(value.content)) {
    throw new RelayValidationError(
      `messages[${index}].content must be a string or an array.`,
    );
  }

  return {
    content: value.content.map((part, partIndex) =>
      parseContentPart(part, partIndex),
    ),
    role,
  };
};

const contentText = (content: ParsedMessage['content']): string => {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .filter((part): part is Extract<ParsedContentPart, { type: 'text' }> =>
      part.type === 'text',
    )
    .map((part) => part.text)
    .join('\n');
};

export const translateMessages = (messages: unknown): {
  developerInstructions?: string;
  input: RelayInputPart[];
} => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RelayValidationError('messages must be a non-empty array.');
  }

  if (messages.length > 256) {
    throw new RelayValidationError('messages cannot contain more than 256 items.');
  }

  const parsedMessages = messages.map(parseMessage);
  const developer: string[] = [];
  const input: RelayInputPart[] = [];

  for (const message of parsedMessages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = contentText(message.content);

      if (text) {
        developer.push(text);
      }

      continue;
    }

    const role = message.role.toUpperCase();
    const content =
      typeof message.content === 'string'
        ? [{ text: message.content, type: 'text' as const }]
        : message.content;

    for (const part of content) {
      if (part.type === 'text') {
        input.push({
          text: `${role}:\n${part.text}`,
          type: 'text',
        });
        continue;
      }

      input.push({ type: 'image', url: part.image_url.url });
    }
  }

  return {
    ...(developer.length > 0
      ? { developerInstructions: developer.join('\n\n') }
      : {}),
    input,
  };
};

export const parseChatCompletionRequest = (
  value: unknown,
): ParsedChatCompletionRequest => {
  if (!isRecord(value)) {
    throw new RelayValidationError('Request body must be a JSON object.');
  }

  const model = value.model ?? 'codex';

  if (typeof model !== 'string' || model.trim() === '') {
    throw new RelayValidationError('model must be a non-empty string.');
  }

  const stream = value.stream ?? false;

  if (typeof stream !== 'boolean') {
    throw new RelayValidationError('stream must be a boolean.');
  }

  const translated = translateMessages(value.messages);

  return {
    ...translated,
    model,
    stream,
  };
};
