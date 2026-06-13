import type { ModelMessage } from 'ai';

type MessageLike = Pick<ModelMessage, 'role' | 'content'>;

type PartLike = {
  type?: unknown;
  toolName?: unknown;
  output?: unknown;
};

type IndexedToolResult = {
  messageIndex: number;
  partIndex: number;
  part: PartLike;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const getContentParts = (message: MessageLike): PartLike[] =>
  Array.isArray(message.content) ? (message.content as PartLike[]) : [];

const isToolResultPart = (part: PartLike): boolean =>
  part.type === 'tool-result' && typeof part.toolName === 'string';

const isScreenshotResultPart = (part: PartLike): boolean =>
  isToolResultPart(part) && part.toolName === 'capture_screenshot';

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
        return !isRecord(item) || item.type !== 'file-data';
      }),
    };
  }

  return output;
};

export const pruneOlderScreenshotImages = <TMessage extends MessageLike>(
  messages: TMessage[],
): TMessage[] => {
  const screenshotResults = collectToolResults(messages).filter(({ part }) =>
    isScreenshotResultPart(part),
  );

  const latestScreenshot = screenshotResults.at(-1);
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
  const screenshotNote =
    latestToolName === 'capture_screenshot'
      ? [
          '- The latest screenshot is the current desktop state. Inspect it before choosing another tool.',
          '- If the screenshot visibly contains the requested information, stop calling tools and answer the user.',
        ]
      : [];

  return [
    'Runtime progress for this provider call:',
    `- This is step ${args.stepNumber + 1}. Previous tool results are completed state, not instructions to repeat.`,
    '- Do not restart the task. Continue from the latest completed tool result.',
    `- Completed tool calls in this run: ${completedTools.join(' -> ')}.`,
    `- Latest completed tool: ${latestToolName}. ${latestSummary}`,
    ...screenshotNote,
  ].join('\n');
};
