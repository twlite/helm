import { tool } from 'ai';
import { z } from 'zod';
import { desktopService } from '../../desktop/desktop-service.ts';
import {
  assertRunNotCancelled,
  type RuntimeToolDependencies,
} from './context.ts';
import { emitToolCall, emitToolResult } from './events.ts';

export const buildScreenshotTools = ({
  context,
  capture,
}: RuntimeToolDependencies) => {
  return {
    capture_screenshot: tool({
      description:
        'Capture a screenshot of the current desktop. Use this before and after impactful actions.',
      inputSchema: z.object({
        detail: z.enum(['low', 'high']).optional(),
      }),
      execute: async (input) => {
        assertRunNotCancelled(context);
        emitToolCall(context, 'capture_screenshot', input);
        capture.onToolCall({ input, toolName: 'capture_screenshot' });

        const [shot, cursor, geometry] = await Promise.all([
          desktopService.screenshot(),
          desktopService.getMouseLocation().catch(() => null),
          desktopService.getDisplayGeometry().catch(() => null),
        ]);

        const imageBase64 = shot.pngBase64.trim();

        if (!imageBase64) {
          const emptyResult = {
            bytes: 0,
            cursor,
            error:
              'Screenshot capture returned empty image data. Desktop session may be unavailable.',
            geometry,
            imageBase64: '',
            mimeType: shot.mimeType,
            ok: false,
          };

          emitToolResult(context, 'capture_screenshot', emptyResult);
          capture.onToolResult({
            output: emptyResult,
            toolName: 'capture_screenshot',
          });

          return emptyResult;
        }

        const result = {
          bytes: imageBase64.length,
          cursor,
          geometry,
          imageBase64,
          mimeType: shot.mimeType,
          ok: true,
        };

        const modelResult = {
          bytes: result.bytes,
          cursor,
          geometry,
          imageSummary: `Screenshot captured (${Math.round(result.bytes / 1024)}KB PNG).`,
          mimeType: shot.mimeType,
          ok: true,
        };

        emitToolResult(context, 'capture_screenshot', result);
        capture.onToolResult({
          output: result,
          toolName: 'capture_screenshot',
        });

        return modelResult;
      },
    }),
  };
};
