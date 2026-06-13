import { tool } from 'ai';
import { posix as pathPosix } from 'node:path';
import { z } from 'zod';
import { desktopService } from '../../desktop/desktop-service.ts';
import {
  assertRunNotCancelled,
  type RuntimeToolDependencies,
} from './context.ts';
import { emitToolCall, emitToolResult } from './events.ts';

const DESKTOP_FILE_ROOT =
  process.env.DESKTOP_FILE_ROOT?.trim() || '/home/agent';

const quoteForShell = (value: string): string => {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
};

const resolveDesktopPath = (inputPath: string): string => {
  const trimmed = inputPath.trim();
  if (!trimmed) {
    throw new Error('Path is required.');
  }

  const normalizedInput = pathPosix.normalize(trimmed);
  const absolutePath = pathPosix.normalize(
    normalizedInput.startsWith('/')
      ? normalizedInput
      : pathPosix.join(DESKTOP_FILE_ROOT, normalizedInput),
  );

  const allowedPrefix = `${DESKTOP_FILE_ROOT.replace(/\/$/, '')}/`;
  if (
    absolutePath !== DESKTOP_FILE_ROOT &&
    !absolutePath.startsWith(allowedPrefix)
  ) {
    throw new Error(
      `Path must stay within ${DESKTOP_FILE_ROOT}. Received: ${inputPath}`,
    );
  }

  return absolutePath;
};

const runDesktopShell = (command: string) => {
  return desktopService.runShellCommand(command);
};

const fileExists = async (absolutePath: string): Promise<boolean> => {
  const result = await runDesktopShell(
    `test -e ${quoteForShell(absolutePath)}`,
  );
  return result.ok;
};

const directoryExists = async (absolutePath: string): Promise<boolean> => {
  const result = await runDesktopShell(
    `test -d ${quoteForShell(absolutePath)}`,
  );
  return result.ok;
};

const regularFileExists = async (absolutePath: string): Promise<boolean> => {
  const result = await runDesktopShell(
    `test -f ${quoteForShell(absolutePath)}`,
  );
  return result.ok;
};

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
    run_terminal_command: tool({
      description:
        'Execute a shell command on the desktop and return stdout/stderr. Runs silently via the container shell — use this for file inspection, curl, or other headless tasks. For tasks requiring visible terminal interaction, open the terminal via open_application, click on it, and type_text the command instead.',
      inputSchema: z.object({
        command: z.string().min(1),
      }),
      execute: async ({ command }) => {
        assertRunNotCancelled(context);
        const input = { command };
        emitToolCall(context, 'run_terminal_command', input);
        capture.onToolCall({ input, toolName: 'run_terminal_command' });

        const result = await desktopService.runShellCommand(command);

        emitToolResult(context, 'run_terminal_command', result);
        capture.onToolResult({
          output: result,
          toolName: 'run_terminal_command',
        });
        return result;
      },
    }),
    create_file: tool({
      description:
        'Create or overwrite a file in the desktop workspace. Prefer this for basic file creation/edit tasks instead of terminal typing.',
      inputSchema: z.object({
        content: z.string(),
        createParentDirectories: z.boolean().default(true),
        overwrite: z.boolean().default(false),
        path: z.string().min(1),
      }),
      execute: async ({
        content,
        createParentDirectories,
        overwrite,
        path,
      }) => {
        assertRunNotCancelled(context);
        const input = {
          contentLength: content.length,
          createParentDirectories,
          overwrite,
          path,
        };
        emitToolCall(context, 'create_file', input);
        capture.onToolCall({ input, toolName: 'create_file' });

        const absolutePath = resolveDesktopPath(path);
        const parentDirectory = pathPosix.dirname(absolutePath);

        if (!overwrite && (await fileExists(absolutePath))) {
          const result = {
            message: 'File already exists and overwrite=false.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'create_file', result);
          capture.onToolResult({ output: result, toolName: 'create_file' });
          return result;
        }

        const encodedContent = Buffer.from(content, 'utf8').toString('base64');
        const shellSteps = [
          'set -e',
          createParentDirectories
            ? `mkdir -p ${quoteForShell(parentDirectory)}`
            : `test -d ${quoteForShell(parentDirectory)}`,
          `printf %s ${quoteForShell(encodedContent)} | base64 -d > ${quoteForShell(absolutePath)}`,
        ];
        const writeResult = await runDesktopShell(shellSteps.join(' && '));

        const result = {
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          ok: writeResult.ok,
          overwrite,
          path: absolutePath,
          stderr: writeResult.stderr,
          stdout: writeResult.stdout,
        };

        emitToolResult(context, 'create_file', result);
        capture.onToolResult({ output: result, toolName: 'create_file' });
        return result;
      },
    }),
    read_file: tool({
      description:
        'Read text from a desktop file. Supports optional line ranges and output length limits.',
      inputSchema: z.object({
        endLine: z.number().int().positive().optional(),
        maxChars: z.number().int().min(1).max(50000).default(12000),
        path: z.string().min(1),
        startLine: z.number().int().positive().optional(),
      }),
      execute: async ({ endLine, maxChars, path, startLine }) => {
        assertRunNotCancelled(context);
        const input = { endLine, maxChars, path, startLine };
        emitToolCall(context, 'read_file', input);
        capture.onToolCall({ input, toolName: 'read_file' });

        if (typeof startLine === 'number' && typeof endLine === 'number') {
          if (endLine < startLine) {
            const result = {
              message: 'endLine must be greater than or equal to startLine.',
              ok: false,
              path,
            };
            emitToolResult(context, 'read_file', result);
            capture.onToolResult({ output: result, toolName: 'read_file' });
            return result;
          }
        }

        const absolutePath = resolveDesktopPath(path);
        if (!(await regularFileExists(absolutePath))) {
          const result = {
            message: 'File does not exist or is not a regular file.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'read_file', result);
          capture.onToolResult({ output: result, toolName: 'read_file' });
          return result;
        }

        let selectorCommand = `cat ${quoteForShell(absolutePath)}`;
        if (typeof startLine === 'number' && typeof endLine === 'number') {
          selectorCommand = `sed -n ${quoteForShell(`${startLine},${endLine}p`)} ${quoteForShell(absolutePath)}`;
        } else if (typeof startLine === 'number') {
          selectorCommand = `sed -n ${quoteForShell(`${startLine},$p`)} ${quoteForShell(absolutePath)}`;
        } else if (typeof endLine === 'number') {
          selectorCommand = `sed -n ${quoteForShell(`1,${endLine}p`)} ${quoteForShell(absolutePath)}`;
        }

        const readResult = await runDesktopShell(
          `${selectorCommand} | head -c ${Math.trunc(maxChars)}`,
        );

        const output = {
          content: readResult.stdout,
          endLine: endLine ?? null,
          maxChars,
          ok: readResult.ok,
          path: absolutePath,
          startLine: startLine ?? null,
          stderr: readResult.stderr,
          truncated: readResult.stdout.length >= maxChars,
        };

        emitToolResult(context, 'read_file', output);
        capture.onToolResult({ output, toolName: 'read_file' });
        return output;
      },
    }),
    delete_file: tool({
      description:
        'Delete a desktop file or directory. Set recursive=true to remove directories.',
      inputSchema: z.object({
        missingOk: z.boolean().default(true),
        path: z.string().min(1),
        recursive: z.boolean().default(false),
      }),
      execute: async ({ missingOk, path, recursive }) => {
        assertRunNotCancelled(context);
        const input = { missingOk, path, recursive };
        emitToolCall(context, 'delete_file', input);
        capture.onToolCall({ input, toolName: 'delete_file' });

        const absolutePath = resolveDesktopPath(path);
        if (absolutePath === DESKTOP_FILE_ROOT) {
          const result = {
            message: 'Refusing to delete the desktop root directory.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'delete_file', result);
          capture.onToolResult({ output: result, toolName: 'delete_file' });
          return result;
        }

        const exists = await fileExists(absolutePath);
        if (!exists && missingOk) {
          const result = {
            deleted: false,
            message: 'Path did not exist; nothing to delete.',
            ok: true,
            path: absolutePath,
          };
          emitToolResult(context, 'delete_file', result);
          capture.onToolResult({ output: result, toolName: 'delete_file' });
          return result;
        }

        if (!exists) {
          const result = {
            message: 'Path does not exist.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'delete_file', result);
          capture.onToolResult({ output: result, toolName: 'delete_file' });
          return result;
        }

        const isDirectory = await directoryExists(absolutePath);
        if (isDirectory && !recursive) {
          const result = {
            message: 'Path is a directory. Set recursive=true to delete it.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'delete_file', result);
          capture.onToolResult({ output: result, toolName: 'delete_file' });
          return result;
        }

        const deleteResult = await runDesktopShell(
          isDirectory
            ? `rm -rf ${quoteForShell(absolutePath)}`
            : `rm -f ${quoteForShell(absolutePath)}`,
        );
        const result = {
          deleted: deleteResult.ok,
          ok: deleteResult.ok,
          path: absolutePath,
          recursive,
          stderr: deleteResult.stderr,
          stdout: deleteResult.stdout,
        };

        emitToolResult(context, 'delete_file', result);
        capture.onToolResult({ output: result, toolName: 'delete_file' });
        return result;
      },
    }),
    open_file: tool({
      description:
        'Open a desktop file or directory in the default GUI application using xdg-open.',
      inputSchema: z.object({
        path: z.string().min(1),
      }),
      execute: async ({ path }) => {
        assertRunNotCancelled(context);
        const input = { path };
        emitToolCall(context, 'open_file', input);
        capture.onToolCall({ input, toolName: 'open_file' });

        const absolutePath = resolveDesktopPath(path);
        if (!(await fileExists(absolutePath))) {
          const result = {
            message: 'Path does not exist.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'open_file', result);
          capture.onToolResult({ output: result, toolName: 'open_file' });
          return result;
        }

        const command = `setsid xdg-open ${quoteForShell(absolutePath)} >/tmp/helm-open-file.log 2>&1 &`;
        const openResult = await runDesktopShell(command);
        const result = {
          ok: openResult.ok,
          path: absolutePath,
          stderr: openResult.stderr,
          stdout: openResult.stdout,
        };

        emitToolResult(context, 'open_file', result);
        capture.onToolResult({ output: result, toolName: 'open_file' });
        return result;
      },
    }),
    list_files: tool({
      description:
        'List files in a desktop directory. Use this to quickly inspect folder contents before reading or opening files.',
      inputSchema: z.object({
        includeHidden: z.boolean().default(false),
        path: z.string().min(1).default('.'),
      }),
      execute: async ({ includeHidden, path }) => {
        assertRunNotCancelled(context);
        const input = { includeHidden, path };
        emitToolCall(context, 'list_files', input);
        capture.onToolCall({ input, toolName: 'list_files' });

        const absolutePath = resolveDesktopPath(path);
        if (!(await directoryExists(absolutePath))) {
          const result = {
            message: 'Directory does not exist.',
            ok: false,
            path: absolutePath,
          };
          emitToolResult(context, 'list_files', result);
          capture.onToolResult({ output: result, toolName: 'list_files' });
          return result;
        }

        const command = includeHidden
          ? `ls -1A ${quoteForShell(absolutePath)}`
          : `ls -1 ${quoteForShell(absolutePath)}`;
        const listResult = await runDesktopShell(command);
        const entries = listResult.stdout
          .split('\n')
          .map((entry) => entry.trim())
          .filter(Boolean);

        const result = {
          entries,
          ok: listResult.ok,
          path: absolutePath,
          stderr: listResult.stderr,
        };

        emitToolResult(context, 'list_files', result);
        capture.onToolResult({ output: result, toolName: 'list_files' });
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
