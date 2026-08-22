export type RelayInputPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      url: string;
    };

export type RelayToolDefinition = {
  description: string;
  inputSchema: unknown;
  name: string;
};

export type RelayToolResultContent =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      url: string;
    };

export type RelayToolResult = {
  content: RelayToolResultContent[];
  toolCallId: string;
};

export type RelayToolCall = {
  arguments: string;
  id: string;
  name: string;
  namespace?: string;
};

export type RelayTurnResult = {
  text: string;
  threadId?: string;
  toolCalls: RelayToolCall[];
  turnId?: string;
};

export type RelayHistoryPart =
  | {
      kind: 'input';
      part: RelayInputPart;
    }
  | {
      arguments: string;
      id: string;
      kind: 'tool-call';
      name: string;
    }
  | {
      content: RelayToolResultContent[];
      id: string;
      kind: 'tool-result';
    };

export class RelayValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayValidationError';
  }
}

type RecordValue = Record<string, unknown>;

type ParsedToolCall = {
  arguments: string;
  id: string;
  name: string;
};

type ParsedMessage =
  | {
      content: string | ParsedContentPart[];
      role: 'system' | 'developer' | 'user' | 'assistant';
      toolCalls?: ParsedToolCall[];
    }
  | {
      content: RelayToolResultContent[];
      role: 'tool';
      toolCallId: string;
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
  history: RelayHistoryPart[];
  input: RelayInputPart[];
  model: string;
  stream: boolean;
  toolResults: RelayToolResult[];
  tools?: RelayToolDefinition[];
};

const EMPTY_OBJECT_SCHEMA = {
  properties: {},
  type: 'object',
};

const isRecord = (value: unknown): value is RecordValue =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const stringifyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toImageDataUrl = (data: string, mediaType: string): string => {
  if (data.toLowerCase().startsWith('data:image/')) {
    return data;
  }

  const normalizedMediaType = mediaType.toLowerCase().startsWith('image/')
    ? mediaType
    : 'image/png';
  return `data:${normalizedMediaType};base64,${data}`;
};

const assertImageUrl = (url: string, label: string): string => {
  if (!url.toLowerCase().startsWith('data:image/')) {
    throw new RelayValidationError(`${label} must be a data:image/... URL.`);
  }

  return url;
};

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

    return {
      image_url: {
        url: assertImageUrl(
          value.image_url.url,
          `messages content part ${index} image_url.url`,
        ),
      },
      type: 'image_url',
    };
  }

  throw new RelayValidationError(
    `Unsupported messages content type: ${value.type}.`,
  );
};

const parseToolOutputItem = (
  value: unknown,
  label: string,
): RelayToolResultContent[] => {
  if (!isRecord(value)) {
    return [{ text: stringifyJson(value), type: 'text' }];
  }

  if (value.type === undefined && typeof value.text === 'string') {
    return [{ text: value.text, type: 'text' }];
  }

  if (typeof value.type !== 'string') {
    return [{ text: stringifyJson(value), type: 'text' }];
  }

  if (value.type === 'text') {
    return [
      {
        text: typeof value.text === 'string' ? value.text : stringifyJson(value),
        type: 'text',
      },
    ];
  }

  if (value.type === 'image_url') {
    if (!isRecord(value.image_url) || typeof value.image_url.url !== 'string') {
      throw new RelayValidationError(`${label}.image_url.url must be a string.`);
    }

    return [
      {
        type: 'image',
        url: assertImageUrl(value.image_url.url, `${label}.image_url.url`),
      },
    ];
  }

  if (
    (value.type === 'media' ||
      value.type === 'image-data' ||
      value.type === 'file-data') &&
    typeof value.data === 'string'
  ) {
    return [
      {
        type: 'image',
        url: toImageDataUrl(
          value.data,
          typeof value.mediaType === 'string' ? value.mediaType : 'image/png',
        ),
      },
    ];
  }

  return [{ text: stringifyJson(value), type: 'text' }];
};

const parseSerializedToolOutput = (
  value: string,
  label: string,
): RelayToolResultContent[] => {
  const trimmed = value.trim();

  if (!trimmed) {
    return [{ text: '', type: 'text' }];
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return [{ text: value, type: 'text' }];
  }

  if (Array.isArray(parsed)) {
    const parts = parsed.flatMap((item, index) =>
      parseToolOutputItem(item, `${label}[${index}]`),
    );
    return parts.length > 0 ? parts : [{ text: value, type: 'text' }];
  }

  if (isRecord(parsed) && typeof parsed.imageBase64 === 'string') {
    const withoutImage = { ...parsed };
    delete withoutImage.imageBase64;

    return [
      {
        text: stringifyJson(withoutImage),
        type: 'text',
      },
      {
        type: 'image',
        url: toImageDataUrl(
          parsed.imageBase64,
          typeof parsed.mimeType === 'string' ? parsed.mimeType : 'image/png',
        ),
      },
    ];
  }

  return [{ text: stringifyJson(parsed), type: 'text' }];
};

const parseToolResultContent = (
  value: unknown,
  label: string,
): RelayToolResultContent[] => {
  if (typeof value === 'string') {
    return parseSerializedToolOutput(value, label);
  }

  if (Array.isArray(value)) {
    const parts = value.flatMap((item, index) =>
      parseToolOutputItem(item, `${label}[${index}]`),
    );
    return parts.length > 0 ? parts : [{ text: '', type: 'text' }];
  }

  return parseToolOutputItem(value, label);
};

const parseToolCall = (value: unknown, index: number): ParsedToolCall => {
  if (!isRecord(value)) {
    throw new RelayValidationError(`assistant tool_calls[${index}] must be an object.`);
  }

  if (typeof value.id !== 'string' || value.id.trim() === '') {
    throw new RelayValidationError(
      `assistant tool_calls[${index}].id must be a non-empty string.`,
    );
  }

  if (value.type !== undefined && value.type !== 'function') {
    throw new RelayValidationError(
      `assistant tool_calls[${index}].type must be function.`,
    );
  }

  if (!isRecord(value.function)) {
    throw new RelayValidationError(
      `assistant tool_calls[${index}].function must be an object.`,
    );
  }

  if (
    typeof value.function.name !== 'string' ||
    value.function.name.trim() === ''
  ) {
    throw new RelayValidationError(
      `assistant tool_calls[${index}].function.name must be a non-empty string.`,
    );
  }

  const rawArguments = value.function.arguments ?? '{}';
  const argumentsText =
    typeof rawArguments === 'string' ? rawArguments : stringifyJson(rawArguments);

  return {
    arguments: argumentsText,
    id: value.id,
    name: value.function.name,
  };
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
    role !== 'assistant' &&
    role !== 'tool'
  ) {
    throw new RelayValidationError(
      `messages[${index}].role must be system, developer, user, assistant, or tool.`,
    );
  }

  if (role === 'tool') {
    if (typeof value.tool_call_id !== 'string' || value.tool_call_id.trim() === '') {
      throw new RelayValidationError(
        `messages[${index}].tool_call_id must be a non-empty string.`,
      );
    }

    return {
      content: parseToolResultContent(
        value.content,
        `messages[${index}].content`,
      ),
      role,
      toolCallId: value.tool_call_id,
    };
  }

  const hasNullContent = value.content === null && role === 'assistant';
  const content =
    typeof value.content === 'string'
      ? value.content
      : hasNullContent
        ? ''
        : Array.isArray(value.content)
          ? value.content.map((part, partIndex) =>
              parseContentPart(part, partIndex),
            )
          : (() => {
              throw new RelayValidationError(
                `messages[${index}].content must be a string, null for assistant tool calls, or an array.`,
              );
            })();

  let toolCalls: ParsedToolCall[] | undefined;

  if (value.tool_calls !== undefined) {
    if (role !== 'assistant' || !Array.isArray(value.tool_calls)) {
      throw new RelayValidationError(
        `messages[${index}].tool_calls must be an array on assistant messages.`,
      );
    }

    toolCalls = value.tool_calls.map(parseToolCall);
  }

  return {
    content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    role,
  };
};

const contentText = (
  content: string | ParsedContentPart[],
): string => {
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

const parseToolDefinitions = (
  value: unknown,
): RelayToolDefinition[] | undefined => {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new RelayValidationError('tools must be an array.');
  }

  if (value.length > 128) {
    throw new RelayValidationError('tools cannot contain more than 128 items.');
  }

  const names = new Set<string>();
  const tools = value.map((tool, index) => {
    if (!isRecord(tool) || tool.type !== 'function' || !isRecord(tool.function)) {
      throw new RelayValidationError(
        `tools[${index}] must be an OpenAI function tool.`,
      );
    }

    const name = tool.function.name;

    if (typeof name !== 'string' || name.trim() === '') {
      throw new RelayValidationError(
        `tools[${index}].function.name must be a non-empty string.`,
      );
    }

    if (name.length > 256) {
      throw new RelayValidationError(
        `tools[${index}].function.name must be 256 characters or fewer.`,
      );
    }

    if (names.has(name)) {
      throw new RelayValidationError(`tools contains duplicate function name: ${name}.`);
    }

    names.add(name);

    const description =
      typeof tool.function.description === 'string'
        ? tool.function.description
        : '';
    const inputSchema = tool.function.parameters ?? EMPTY_OBJECT_SCHEMA;

    return { description, inputSchema, name };
  });

  return tools.length > 0 ? tools : undefined;
};

export const translateMessages = (messages: unknown): {
  developerInstructions?: string;
  history: RelayHistoryPart[];
  input: RelayInputPart[];
  toolResults: RelayToolResult[];
} => {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new RelayValidationError('messages must be a non-empty array.');
  }

  if (messages.length > 256) {
    throw new RelayValidationError('messages cannot contain more than 256 items.');
  }

  const parsedMessages = messages.map(parseMessage);
  const developer: string[] = [];
  const history: RelayHistoryPart[] = [];
  const input: RelayInputPart[] = [];
  const toolResults: RelayToolResult[] = [];

  for (const message of parsedMessages) {
    if (message.role === 'system' || message.role === 'developer') {
      const text = contentText(message.content);

      if (text) {
        developer.push(text);
      }

      continue;
    }

    if (message.role === 'tool') {
      toolResults.push({
        content: message.content,
        toolCallId: message.toolCallId,
      });
      history.push({
        content: message.content,
        id: message.toolCallId,
        kind: 'tool-result',
      });
      continue;
    }

    for (const call of message.toolCalls ?? []) {
      history.push({
        arguments: call.arguments,
        id: call.id,
        kind: 'tool-call',
        name: call.name,
      });
    }

    const role = message.role.toUpperCase();
    const content =
      typeof message.content === 'string'
        ? [{ text: message.content, type: 'text' as const }]
        : message.content;

    for (const part of content) {
      if (part.type === 'text') {
        if (message.role === 'assistant' && part.text === '') {
          continue;
        }

        const translated = {
          text: `${role}:\n${part.text}`,
          type: 'text' as const,
        };
        input.push(translated);
        history.push({ kind: 'input', part: translated });
        continue;
      }

      const translated = { type: 'image' as const, url: part.image_url.url };
      input.push(translated);
      history.push({ kind: 'input', part: translated });
    }
  }

  return {
    ...(developer.length > 0
      ? { developerInstructions: developer.join('\n\n') }
      : {}),
    history,
    input,
    toolResults,
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
    tools: parseToolDefinitions(value.tools),
  };
};
