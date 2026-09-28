import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';

import { ApplicationController } from '../src/apps';
import type { BrowserController } from '../src/browser';
import type { CommandExecutor, CommandResult, KnownCommandName } from '../src/commands';
import { GuestRpcError } from '../src/errors';
import { GuestSandbox } from '../src/sandbox';

describe('application file opening', () => {
  it('checks file existence before application side effects and opens an existing file directly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-app-open-file-'));
    try {
      const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
      const spawned: Array<{ command: KnownCommandName; args: readonly string[] }> = [];
      const commands: CommandExecutor = {
        async run(command): Promise<CommandResult> {
          return { command, executable: command, exitCode: 0, stdout: '', stderr: '' };
        },
        async spawn(command, args) {
          spawned.push({ command, args });
          return { pid: 123 };
        },
        async available() { return true; },
      };
      const applications = new ApplicationController(sandbox, {} as BrowserController, commands);

      await expect(applications.openFile('forex.txt', 'text-editor')).rejects.toMatchObject({
        name: 'GuestRpcError',
        code: 'FILE_NOT_FOUND',
      } satisfies Partial<GuestRpcError>);
      expect(spawned).toEqual([]);

      const file = await sandbox.write('forex.txt', 'USD | 153.01 | 153.61\n');
      const opened = await applications.openFile('forex.txt', 'text-editor');
      expect(opened).toMatchObject({ application: 'text-editor', path: file.path, launched: true });
      expect(spawned).toEqual([{ command: 'text-editor', args: [file.path] }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
