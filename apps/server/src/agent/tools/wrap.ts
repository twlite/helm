import type { ToolCapture, ToolContext } from './context.ts';
import { emitToolResult } from './events.ts';

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const withFailureToolResults = <
  TTools extends Record<string, unknown>,
>(args: {
  context: ToolContext;
  capture: ToolCapture;
  tools: TTools;
}): TTools => {
  const wrapped = { ...args.tools } as Record<string, unknown>;

  for (const [toolName, definition] of Object.entries(wrapped)) {
    if (!definition || typeof definition !== 'object') {
      continue;
    }

    const maybeTool = definition as {
      execute?: (input: unknown) => Promise<unknown>;
    };

    if (typeof maybeTool.execute !== 'function') {
      continue;
    }

    const originalExecute = maybeTool.execute.bind(maybeTool);

    maybeTool.execute = async (input: unknown) => {
      try {
        return await originalExecute(input);
      } catch (error) {
        const output = {
          error: toErrorMessage(error),
          ok: false,
        };

        emitToolResult(args.context, toolName, output);
        args.capture.onToolResult({ output, toolName });
        throw error;
      }
    };
  }

  return wrapped as TTools;
};
