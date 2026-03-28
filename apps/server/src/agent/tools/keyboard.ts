import { tool } from 'ai';
import { z } from 'zod';
import { desktopService } from '../../desktop/desktop-service.ts';
import {
  assertRunNotCancelled,
  type RuntimeToolDependencies,
} from './context.ts';
import { emitToolCall, emitToolResult } from './events.ts';

export const buildKeyboardTools = ({
  context,
  capture,
}: RuntimeToolDependencies) => {
  let lastTypeTextCall: {
    delayMs: number;
    text: string;
    timestamp: number;
  } | null = null;

  const TYPE_TEXT_DUPLICATE_WINDOW_MS = 1500;

  return {
    hotkey: tool({
      description: 'Press a key combination such as ["ctrl", "l"].',
      inputSchema: z.object({
        keys: z.array(z.string().min(1)).min(1),
      }),
      execute: async ({ keys }) => {
        assertRunNotCancelled(context);
        const callInput = { keys };
        emitToolCall(context, 'hotkey', callInput);
        capture.onToolCall({ input: callInput, toolName: 'hotkey' });

        await desktopService.hotkey(keys);

        const result = { keys, ok: true };
        emitToolResult(context, 'hotkey', result);
        capture.onToolResult({ output: result, toolName: 'hotkey' });
        return result;
      },
    }),
    press_key: tool({
      description:
        'Press a key or key combination such as "Escape" or "ctrl+c".',
      inputSchema: z.object({
        keyOrCombo: z.string().min(1),
      }),
      execute: async ({ keyOrCombo }) => {
        assertRunNotCancelled(context);
        const callInput = { keyOrCombo };
        emitToolCall(context, 'press_key', callInput);
        capture.onToolCall({ input: callInput, toolName: 'press_key' });

        await desktopService.pressKey(keyOrCombo);

        const result = { keyOrCombo, ok: true };
        emitToolResult(context, 'press_key', result);
        capture.onToolResult({ output: result, toolName: 'press_key' });
        return result;
      },
    }),
    type_text: tool({
      description: 'Type text into the currently focused input field.',
      inputSchema: z.object({
        delayMs: z.number().int().min(0).max(100).default(12),
        text: z.string(),
      }),
      execute: async ({ text, delayMs }) => {
        assertRunNotCancelled(context);
        const callInput = {
          delayMs,
          length: text.length,
        };
        emitToolCall(context, 'type_text', callInput);
        capture.onToolCall({ input: callInput, toolName: 'type_text' });

        const now = Date.now();
        const isRapidDuplicate =
          lastTypeTextCall &&
          lastTypeTextCall.text === text &&
          lastTypeTextCall.delayMs === delayMs &&
          now - lastTypeTextCall.timestamp <= TYPE_TEXT_DUPLICATE_WINDOW_MS;

        if (isRapidDuplicate) {
          const result = {
            delayMs,
            length: text.length,
            ok: true,
            skippedDuplicate: true,
          };

          emitToolResult(context, 'type_text', result);
          capture.onToolResult({ output: result, toolName: 'type_text' });
          return result;
        }

        await desktopService.typeText(text, delayMs);

        lastTypeTextCall = {
          delayMs,
          text,
          timestamp: now,
        };

        const result = {
          delayMs,
          length: text.length,
          ok: true,
        };

        emitToolResult(context, 'type_text', result);
        capture.onToolResult({ output: result, toolName: 'type_text' });
        return result;
      },
    }),
  };
};
