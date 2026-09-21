import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../apps/server/src/config';

const repositoryRoot = resolve(import.meta.dir, '..');
const child = Bun.spawn(['bun', 'run', '--cwd', 'guest/helm-guest', 'build'], {
  cwd: repositoryRoot,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await child.exited;
if (exitCode !== 0) {
  process.exitCode = exitCode;
} else {
  const source = join(repositoryRoot, 'runtime', 'guest', 'helm-guest.js');
  if (!existsSync(source)) {
    throw new Error(`Guest build completed without producing ${source}`);
  }

  const config = loadConfig();
  const destination = join(config.runtimeDir, 'guest', 'helm-guest.js');
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  console.log(`Copied guest runtime to ${destination}`);
}
