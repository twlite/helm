import { publishRunEvent } from '../../services/run-events.ts';
import type { ToolContext } from './context.ts';

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const toEventSafeToolOutput = (
  toolName: string,
  output: object,
): Record<string, unknown> => {
  const record = output as Record<string, unknown>;
  if (toolName !== 'capture_screenshot') {
    return record;
  }

  const base64 = normalizeText(record.imageBase64);
  if (!base64) {
    return record;
  }

  const kb = Math.round(base64.length / 1024);
  return {
    ...record,
    imageSummary: `[screenshot PNG (${kb}KB)]`,
  };
};

export const emitToolCall = (
  context: ToolContext,
  toolName: string,
  input: Record<string, unknown>,
): void => {
  publishRunEvent({
    conversationId: context.conversationId,
    eventType: 'tool_call',
    payload: {
      input,
      toolName,
    },
    runId: context.runId,
  });
};

export const emitToolResult = (
  context: ToolContext,
  toolName: string,
  output: object,
): void => {
  const eventOutput = toEventSafeToolOutput(toolName, output);

  publishRunEvent({
    conversationId: context.conversationId,
    eventType: 'tool_result',
    payload: {
      output: eventOutput,
      toolName,
    },
    runId: context.runId,
  });
};
