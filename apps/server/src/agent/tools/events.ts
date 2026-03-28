import { publishRunEvent } from '../../services/run-events.ts';
import type { ToolContext } from './context.ts';

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const toEventSafeToolOutput = (
  toolName: string,
  output: Record<string, unknown>,
): Record<string, unknown> => {
  if (toolName !== 'capture_screenshot') {
    return output;
  }

  const base64 = normalizeText(output.imageBase64);
  if (!base64) {
    return output;
  }

  const kb = Math.round(base64.length / 1024);
  return {
    ...output,
    imageBase64: '',
    imageSummary: `[omitted screenshot base64 (${kb}KB)]`,
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
  output: Record<string, unknown>,
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
