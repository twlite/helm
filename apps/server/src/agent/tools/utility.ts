import { tool } from 'ai';
import { z } from 'zod';
import { desktopService } from '../../desktop/desktop-service.ts';
import {
  assertRunNotCancelled,
  type RuntimeToolDependencies,
} from './context.ts';
import { emitToolCall, emitToolResult } from './events.ts';

export const buildUtilityTools = ({
  context,
  capture,
}: RuntimeToolDependencies) => {
  return {
    get_display_geometry: tool({
      description: 'Return desktop display width and height.',
      inputSchema: z.object({}),
      execute: async () => {
        assertRunNotCancelled(context);
        emitToolCall(context, 'get_display_geometry', {});
        capture.onToolCall({ input: {}, toolName: 'get_display_geometry' });

        const geometry = await desktopService.getDisplayGeometry();
        const output = {
          height: geometry.height,
          width: geometry.width,
        };

        emitToolResult(context, 'get_display_geometry', output);
        capture.onToolResult({ output, toolName: 'get_display_geometry' });
        return geometry;
      },
    }),
    wait: tool({
      description: 'Pause briefly to allow UI changes to settle.',
      inputSchema: z.object({
        milliseconds: z.number().int().min(50).max(5000).default(500),
      }),
      execute: async ({ milliseconds }) => {
        assertRunNotCancelled(context);
        const callInput = { milliseconds };
        emitToolCall(context, 'wait', callInput);
        capture.onToolCall({ input: callInput, toolName: 'wait' });

        await new Promise((resolve) => setTimeout(resolve, milliseconds));

        const result = { ok: true, waitedMs: milliseconds };
        emitToolResult(context, 'wait', result);
        capture.onToolResult({ output: result, toolName: 'wait' });
        return result;
      },
    }),
  };
};
