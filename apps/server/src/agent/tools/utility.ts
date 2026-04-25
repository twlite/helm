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
    list_desktop_windows: tool({
      description:
        'List visible desktop windows by id and title. Use this to verify whether an app opened or which window is focused.',
      inputSchema: z.object({}),
      execute: async () => {
        assertRunNotCancelled(context);
        emitToolCall(context, 'list_desktop_windows', {});
        capture.onToolCall({ input: {}, toolName: 'list_desktop_windows' });

        const windows = await desktopService.listWindows().catch(() => []);
        const output = {
          count: windows.length,
          ok: true,
          windows,
        };

        emitToolResult(context, 'list_desktop_windows', output);
        capture.onToolResult({ output, toolName: 'list_desktop_windows' });
        return output;
      },
    }),
    open_application: tool({
      description:
        'Open or focus a known desktop app without clicking. Prefer this for Firefox or Terminal. If the app is already visible, this focuses it instead of launching another copy.',
      inputSchema: z.object({
        app: z.enum(['firefox', 'terminal']),
      }),
      execute: async ({ app }) => {
        assertRunNotCancelled(context);
        const input = { app };
        emitToolCall(context, 'open_application', input);
        capture.onToolCall({ input, toolName: 'open_application' });

        const launchResult = await desktopService.launchApplication(app);

        const result = {
          ...launchResult,
          ok: true,
        };
        emitToolResult(context, 'open_application', result);
        capture.onToolResult({ output: result, toolName: 'open_application' });
        return result;
      },
    }),
    navigate_browser_url: tool({
      description:
        'Navigate the focused Firefox window to a URL using reliable keyboard input. This focuses or opens Firefox first, presses Ctrl+L, types the URL, and presses Enter.',
      inputSchema: z.object({
        url: z.string().url(),
      }),
      execute: async ({ url }) => {
        assertRunNotCancelled(context);
        const input = { url };
        emitToolCall(context, 'navigate_browser_url', input);
        capture.onToolCall({ input, toolName: 'navigate_browser_url' });

        const launchResult = await desktopService.launchApplication('firefox');
        await desktopService.hotkey(['ctrl', 'l']);
        await desktopService.typeText(url, 4);
        await desktopService.pressKey('Enter');
        await new Promise((resolve) => setTimeout(resolve, 1200));

        const windows = await desktopService.listWindows().catch(
          () => launchResult.windows,
        );
        const result = {
          app: 'firefox',
          focusedWindow: launchResult.matchedWindow ?? null,
          ok: true,
          url,
          windows,
        };

        emitToolResult(context, 'navigate_browser_url', result);
        capture.onToolResult({
          output: result,
          toolName: 'navigate_browser_url',
        });
        return result;
      },
    }),
    run_terminal_command: tool({
      description:
        'Run a shell command in the desktop user home directory and return stdout/stderr. Prefer this for terminal tasks that create files, edit files, or preview command output with cat.',
      inputSchema: z.object({
        command: z.string().min(1),
      }),
      execute: async ({ command }) => {
        assertRunNotCancelled(context);
        const input = { command };
        emitToolCall(context, 'run_terminal_command', input);
        capture.onToolCall({ input, toolName: 'run_terminal_command' });

        const launchResult = await desktopService.launchApplication('terminal');
        const result = {
          ...(await desktopService.runShellCommand(command)),
          focusedWindow: launchResult.matchedWindow ?? null,
        };

        emitToolResult(context, 'run_terminal_command', result);
        capture.onToolResult({
          output: result,
          toolName: 'run_terminal_command',
        });
        return result;
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
