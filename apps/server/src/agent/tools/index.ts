import type { ToolCapture, ToolContext } from './context.ts';
import { assertRunNotCancelled, isRunCancelledError } from './context.ts';
import { buildKeyboardTools } from './keyboard.ts';
import { buildMouseTools } from './mouse.ts';
import { buildScreenshotTools } from './screenshot.ts';
import { buildUtilityTools } from './utility.ts';
import { withFailureToolResults } from './wrap.ts';

export { assertRunNotCancelled, isRunCancelledError };
export type { ToolCapture, ToolContext };

export const buildRuntimeTools = (args: {
  context: ToolContext;
  capture: ToolCapture;
}) => {
  const tools = {
    ...buildScreenshotTools(args),
    ...buildMouseTools(args),
    ...buildKeyboardTools(args),
    ...buildUtilityTools(args),
  };

  return withFailureToolResults({
    capture: args.capture,
    context: args.context,
    tools,
  });
};
