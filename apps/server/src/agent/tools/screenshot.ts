import { tool } from 'ai';
import { z } from 'zod';
import { desktopService } from '../../desktop/desktop-service.ts';
import {
  assertRunNotCancelled,
  type RuntimeToolDependencies,
} from './context.ts';
import { emitToolCall, emitToolResult } from './events.ts';

type ScreenshotToolOutput = {
  ok: boolean;
  mimeType?: string;
  imageBase64?: string;
  bytes?: number;
  geometry?: { width: number; height: number } | null;
  cursor?: { x: number; y: number } | null;
  error?: string;
};

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const toNumber = (value: unknown): number | null => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const buildScreenshotText = (output: ScreenshotToolOutput): string => {
  const bytes = toNumber(output.bytes) ?? 0;
  const kb = Math.max(0, Math.round(bytes / 1024));
  const geometry = output.geometry;
  const cursor = output.cursor;

  const geometryText =
    geometry && Number.isFinite(geometry.width) && Number.isFinite(geometry.height)
      ? `${geometry.width}x${geometry.height}`
      : 'unknown';

  const cursorText =
    cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)
      ? `(${cursor.x}, ${cursor.y})`
      : 'unknown';

  return `Screenshot captured (${kb}KB PNG). Geometry: ${geometryText}. Cursor: ${cursorText}.`;
};

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
      toModelOutput: ({ output }) => {
        const typedOutput = output as ScreenshotToolOutput;
        const imageBase64 = normalizeText(typedOutput.imageBase64);
        const mimeType = normalizeText(typedOutput.mimeType) || 'image/png';

        if (!typedOutput.ok || !imageBase64) {
          const errorText =
            normalizeText(typedOutput.error) ||
            'Screenshot capture failed or returned empty image data.';

          return {
            type: 'content' as const,
            value: [{ type: 'text' as const, text: errorText }],
          };
        }

        return {
          type: 'content' as const,
          value: [
            {
              type: 'text' as const,
              text: buildScreenshotText(typedOutput),
            },
            {
              type: 'file-data' as const,
              data: imageBase64,
              mediaType: mimeType,
              filename: 'desktop-screenshot.png',
            },
          ],
        };
      },
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

        const result: ScreenshotToolOutput = {
          bytes: imageBase64.length,
          cursor,
          geometry,
          imageBase64,
          mimeType: shot.mimeType,
          ok: true,
        };

        emitToolResult(context, 'capture_screenshot', result);
        capture.onToolResult({
          output: result,
          toolName: 'capture_screenshot',
        });

        return result;
      },
    }),
  };
};
