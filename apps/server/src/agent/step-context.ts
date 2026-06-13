import type { ModelMessage } from 'ai';

type MessageLike = Pick<ModelMessage, 'role' | 'content'>;

type PartLike = {
  type?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
};

type IndexedToolResult = {
  messageIndex: number;
  partIndex: number;
  part: PartLike;
};

type IndexedToolCall = {
  messageIndex: number;
  partIndex: number;
  part: PartLike;
};

type ToolTimelineEntry = {
  summary: string;
  toolName: string;
  type: 'call' | 'result';
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const truncate = (text: string, max = 360): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

const compactJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const URL_LIKE_TEXT_PATTERN =
  /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}([/?#].*)?$/i;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getContentParts = (message: MessageLike): PartLike[] =>
  Array.isArray(message.content) ? (message.content as PartLike[]) : [];

const isToolResultPart = (part: PartLike): boolean =>
  part.type === 'tool-result' && typeof part.toolName === 'string';

const isToolCallPart = (part: PartLike): boolean =>
  part.type === 'tool-call' && typeof part.toolName === 'string';

const isScreenshotResultPart = (part: PartLike): boolean =>
  isToolResultPart(part) && part.toolName === 'capture_screenshot';

const getLatestScreenshotResult = (
  messages: MessageLike[],
): IndexedToolResult | null => {
  return collectToolResults(messages)
    .filter(({ part }) => isScreenshotResultPart(part))
    .at(-1) ?? null;
};

const collectToolCalls = (messages: MessageLike[]): IndexedToolCall[] => {
  const calls: IndexedToolCall[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.role !== 'assistant') {
      return;
    }

    getContentParts(message).forEach((part, partIndex) => {
      if (isToolCallPart(part)) {
        calls.push({ messageIndex, partIndex, part });
      }
    });
  });

  return calls;
};

const collectToolResults = (messages: MessageLike[]): IndexedToolResult[] => {
  const results: IndexedToolResult[] = [];

  messages.forEach((message, messageIndex) => {
    if (message.role !== 'tool') {
      return;
    }

    getContentParts(message).forEach((part, partIndex) => {
      if (isToolResultPart(part)) {
        results.push({ messageIndex, partIndex, part });
      }
    });
  });

  return results;
};

const summarizeToolCall = (toolName: string, input: unknown): string => {
  if (!isRecord(input)) {
    return `${toolName} called`;
  }

  if (toolName === 'type_text') {
    const text = normalizeText(input.text);
    return text
      ? `type_text called with text="${truncate(text, 100)}"`
      : `type_text called with length=${input.length ?? 'unknown'}`;
  }

  if (toolName === 'press_key') {
    return `press_key called with key="${normalizeText(input.keyOrCombo) || 'unknown'}"`;
  }

  if (toolName === 'hotkey') {
    const keys = Array.isArray(input.keys)
      ? input.keys.map(normalizeText).filter(Boolean).join('+')
      : '';
    return `hotkey called with keys="${keys || 'unknown'}"`;
  }

  if (toolName === 'open_application') {
    return `open_application called for app="${normalizeText(input.app) || 'unknown'}"`;
  }

  if (toolName === 'move_mouse' || toolName === 'click_mouse') {
    const x = typeof input.x === 'number' ? input.x : null;
    const y = typeof input.y === 'number' ? input.y : null;
    return x !== null && y !== null
      ? `${toolName} called at (${x}, ${y})`
      : `${toolName} called`;
  }

  if (toolName === 'create_file') {
    return `create_file called for path="${normalizeText(input.path) || 'unknown'}"`;
  }

  return `${toolName} called with input ${truncate(compactJson(input), 180)}`;
};

const summarizeToolResultForTrace = (
  toolName: string,
  output: unknown,
): string => {
  if (!isRecord(output)) {
    return `${toolName} completed with ${truncate(compactJson(output), 160)}`;
  }

  if (toolName === 'capture_screenshot') {
    return `capture_screenshot completed. ${summarizeToolOutput(toolName, output)}`;
  }

  const ok = output.ok === true ? 'ok=true' : output.ok === false ? 'ok=false' : '';
  if (toolName === 'press_key') {
    return `press_key completed ${ok}`.trim();
  }

  if (toolName === 'type_text') {
    return `type_text completed ${ok} length=${output.length ?? 'unknown'}`.trim();
  }

  if (toolName === 'create_file') {
    return `create_file completed ${ok} path="${normalizeText(output.path) || 'unknown'}" bytes=${output.bytesWritten ?? 'unknown'}`.trim();
  }

  return `${toolName} completed ${truncate(compactJson(output), 180)}`;
};

const collectToolTimeline = (messages: MessageLike[]): ToolTimelineEntry[] => {
  const entries: Array<{
    messageIndex: number;
    partIndex: number;
    summary: string;
    toolName: string;
    type: 'call' | 'result';
  }> = [];

  for (const call of collectToolCalls(messages)) {
    const toolName = normalizeText(call.part.toolName);
    if (!toolName) {
      continue;
    }

    entries.push({
      messageIndex: call.messageIndex,
      partIndex: call.partIndex,
      summary: summarizeToolCall(toolName, call.part.input),
      toolName,
      type: 'call',
    });
  }

  for (const result of collectToolResults(messages)) {
    const toolName = normalizeText(result.part.toolName);
    if (!toolName) {
      continue;
    }

    entries.push({
      messageIndex: result.messageIndex,
      partIndex: result.partIndex,
      summary: summarizeToolResultForTrace(toolName, result.part.output),
      toolName,
      type: 'result',
    });
  }

  return entries
    .sort(
      (a, b) =>
        a.messageIndex - b.messageIndex ||
        a.partIndex - b.partIndex ||
        (a.type === 'call' ? -1 : 1),
    )
    .map(({ summary, toolName, type }) => ({ summary, toolName, type }));
};

const collectNavigationGuardNotes = (
  timeline: ToolTimelineEntry[],
): string[] => {
  const latestTypedUrlIndex = timeline.findLastIndex(
    (entry) =>
      entry.type === 'call' &&
      entry.toolName === 'type_text' &&
      URL_LIKE_TEXT_PATTERN.test(
        entry.summary.match(/text="([^"]+)"/)?.[1] ?? '',
      ),
  );

  if (latestTypedUrlIndex === -1) {
    return [];
  }

  const afterTypedUrl = timeline.slice(latestTypedUrlIndex + 1);
  const enterPressedIndex = afterTypedUrl.findIndex(
    (entry) =>
      entry.type === 'call' &&
      entry.toolName === 'press_key' &&
      /key="enter"/i.test(entry.summary),
  );

  if (enterPressedIndex === -1) {
    return [
      '- A URL-like value was typed recently, but Enter has not been pressed after it. The next action should be press_key with Enter, not extraction or completion.',
    ];
  }

  const afterEnter = afterTypedUrl.slice(enterPressedIndex + 1);
  const screenshotAfterEnter = afterEnter.some(
    (entry) => entry.type === 'result' && entry.toolName === 'capture_screenshot',
  );

  if (!screenshotAfterEnter) {
    return [
      '- Enter was pressed after typing a URL, but no screenshot has verified the loaded page yet. Capture a screenshot before claiming the webpage is open or empty.',
    ];
  }

  return [];
};

const sameResultPosition = (
  a: IndexedToolResult,
  b: IndexedToolResult,
): boolean => a.messageIndex === b.messageIndex && a.partIndex === b.partIndex;

const stripScreenshotImagePayload = (output: unknown): unknown => {
  if (!isRecord(output)) {
    return output;
  }

  if (typeof output.imageBase64 === 'string') {
    return { ...output, imageBase64: '' };
  }

  if (output.type === 'content' && Array.isArray(output.value)) {
    return {
      ...output,
      value: output.value.filter((item) => {
        return (
          !isRecord(item) ||
          !['file-data', 'image-data', 'media'].includes(normalizeText(item.type))
        );
      }),
    };
  }

  return output;
};

export const pruneOlderScreenshotImages = <TMessage extends MessageLike>(
  messages: TMessage[],
): TMessage[] => {
  const latestScreenshot = getLatestScreenshotResult(messages);
  if (!latestScreenshot) {
    return messages;
  }

  let changed = false;

  const pruned = messages.map((message, messageIndex) => {
    if (message.role !== 'tool' || !Array.isArray(message.content)) {
      return message;
    }

    const nextContent = message.content.map((part, partIndex) => {
      const partLike = part as PartLike;
      if (
        !isScreenshotResultPart(partLike) ||
        sameResultPosition(
          { messageIndex, partIndex, part: partLike },
          latestScreenshot,
        )
      ) {
        return part;
      }

      const nextOutput = stripScreenshotImagePayload(partLike.output);
      if (nextOutput === partLike.output) {
        return part;
      }

      changed = true;
      return {
        ...partLike,
        output: nextOutput,
      };
    });

    return {
      ...message,
      content: nextContent,
    };
  });

  return changed ? (pruned as TMessage[]) : messages;
};

export const appendLatestScreenshotImageMessage = <
  TMessage extends MessageLike,
>(
  messages: TMessage[],
): TMessage[] => {
  const latestScreenshot = getLatestScreenshotResult(messages);
  const output = latestScreenshot?.part.output;
  if (!isRecord(output)) {
    return messages;
  }

  const imageBase64 = normalizeText(output.imageBase64);
  if (!imageBase64) {
    return messages;
  }

  const mimeType = normalizeText(output.mimeType) || 'image/png';
  const screenshotMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          'Latest desktop screenshot image for visual inspection.',
          'Use this image to read visible page text and UI state.',
          'Do not replace visible text with placeholders such as "visible field if discernible" or "requires OCR".',
        ].join(' '),
      },
      {
        type: 'file',
        data: imageBase64,
        mediaType: mimeType,
        filename: 'desktop-screenshot.png',
      },
    ],
  } as TMessage;

  return [...messages, screenshotMessage];
};

const summarizeWindows = (windows: unknown): string => {
  if (!Array.isArray(windows)) {
    return '';
  }

  const names = windows
    .map((window) =>
      isRecord(window) ? normalizeText(window.name) : '',
    )
    .filter(Boolean);

  return names.length > 0 ? ` Open windows: ${names.join('; ')}.` : '';
};

const summarizeToolOutput = (toolName: string, output: unknown): string => {
  if (!isRecord(output)) {
    return truncate(compactJson(output));
  }

  if (output.type === 'content' && Array.isArray(output.value)) {
    const text = output.value
      .map((item) => (isRecord(item) ? normalizeText(item.text) : ''))
      .filter(Boolean)
      .join(' ');

    return text ? truncate(text) : 'Model output contains no text summary.';
  }

  if (toolName === 'capture_screenshot') {
    const ok = output.ok === true ? 'ok=true.' : '';
    const geometry = isRecord(output.geometry)
      ? ` Geometry: ${output.geometry.width ?? 'unknown'}x${
          output.geometry.height ?? 'unknown'
        }.`
      : '';

    return truncate(
      `${ok}${geometry}${summarizeWindows(output.windows)}`.trim() ||
        compactJson(output),
    );
  }

  return truncate(compactJson(output));
};

export const buildStepSystemContext = (args: {
  messages: MessageLike[];
  stepNumber: number;
}): string | null => {
  const toolResults = collectToolResults(args.messages);
  if (toolResults.length === 0) {
    return null;
  }

  const completedTools = toolResults
    .map(({ part }) => normalizeText(part.toolName))
    .filter(Boolean);
  const latest = toolResults.at(-1);
  if (!latest) {
    return null;
  }

  const latestToolName = normalizeText(latest.part.toolName) || 'unknown_tool';
  const latestSummary = summarizeToolOutput(latestToolName, latest.part.output);
  const toolTimeline = collectToolTimeline(args.messages);
  const recentActionTrace = toolTimeline
    .slice(-10)
    .map((entry, index) => `${index + 1}. ${entry.summary}`);
  const navigationGuardNotes = collectNavigationGuardNotes(toolTimeline);
  const screenshotNote =
    latestToolName === 'capture_screenshot'
      ? [
          '- The latest screenshot is the current desktop state. Inspect it before choosing another tool.',
          '- Do not contradict completed action history. If the trace shows a URL was typed and Enter was pressed, do not claim navigation has not happened.',
          '- If the screenshot window title shows a page title in Firefox, treat that as evidence a page is loaded.',
          '- If the screenshot visibly contains the requested information, stop calling tools and answer the user.',
        ]
      : [];

  return [
    'Runtime progress for this provider call:',
    `- This is step ${args.stepNumber + 1}. Previous tool results are completed state, not instructions to repeat.`,
    '- Do not restart the task. Continue from the latest completed tool result.',
    `- Completed tool calls in this run: ${completedTools.join(' -> ')}.`,
    ...(recentActionTrace.length > 0
      ? ['- Recent action trace:', ...recentActionTrace.map((line) => `  ${line}`)]
      : []),
    `- Latest completed tool: ${latestToolName}. ${latestSummary}`,
    ...navigationGuardNotes,
    ...screenshotNote,
  ].join('\n');
};
