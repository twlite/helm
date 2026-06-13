import { getRunById } from '../../database/store.ts';
import { isRunCancellationRequested } from '../../services/run-control.ts';

export interface ToolContext {
  conversationId: string;
  runId: string;
  abortSignal: AbortSignal;
}

export interface ToolCapture {
  onToolCall: (entry: {
    toolName: string;
    input: Record<string, unknown>;
  }) => void;
  onToolResult: (entry: {
    toolName: string;
    output: object;
  }) => void;
}

export interface RuntimeToolDependencies {
  context: ToolContext;
  capture: ToolCapture;
}

export class RunCancelledError extends Error {
  public constructor(message = 'Run cancelled by user.') {
    super(message);
    this.name = 'RunCancelledError';
  }
}

export const assertRunNotCancelled = (context: ToolContext): void => {
  if (
    context.abortSignal.aborted ||
    isRunCancellationRequested(context.runId)
  ) {
    throw new RunCancelledError();
  }

  const run = getRunById(context.runId);
  if (run?.status === 'cancelled') {
    throw new RunCancelledError();
  }
};

export const isRunCancelledError = (error: unknown): boolean => {
  if (error instanceof RunCancelledError) {
    return true;
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }

  return false;
};
