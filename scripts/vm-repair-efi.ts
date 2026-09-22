import { createInterface } from 'node:readline/promises';
import { stat } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { loadConfig } from '../apps/server/src/config';
import { isVmRunning, VmDeleteError } from '../apps/server/src/vm/vm-delete';
import { virtualizationHelperAvailable } from '../apps/server/src/vm/helper';

function usage(exitCode = 1): never {
  const output = [
    'Usage: bun run vm:repair-efi [--yes]',
    '',
    '  Replaces only efi-vars.bin after preserving it as a .bak file.',
    '  The guest disk is never changed.',
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(output);
  process.exit(exitCode);
}

let yes = false;
for (const argument of Bun.argv.slice(2)) {
  if (argument === '--yes') {
    yes = true;
    continue;
  }
  if (argument === '--help' || argument === '-h') usage(0);
  console.error(`Unknown option: ${argument}`);
  usage();
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('EFI repair requires an Apple Silicon macOS host.');
  process.exit(1);
}

const config = loadConfig();
const vmDirectory = resolve(config.vmDir);
const efiPath = resolve(config.efiVariablesPath);
if (basename(efiPath) !== 'efi-vars.bin' || dirname(efiPath) !== vmDirectory) {
  console.error('Refusing EFI repair: the configured EFI path is outside Helm\'s canonical VM directory.');
  process.exit(1);
}
if (!virtualizationHelperAvailable(config.vmHelperPath)) {
  console.error(`Signed Virtualization.framework helper not found at ${config.vmHelperPath}`);
  console.error('Run `bun run vm:build` first, then retry EFI repair.');
  process.exit(1);
}

try {
  const info = await stat(efiPath);
  if (!info.isFile()) {
    console.error(`The EFI path is not a regular file: ${efiPath}`);
    process.exit(1);
  }
} catch {
  console.error(`No EFI variable store exists at ${efiPath}. Normal VM startup creates it automatically.`);
  process.exit(1);
}

try {
  if (await isVmRunning(config)) {
    throw new VmDeleteError('VM is running. Stop it before repairing EFI state.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (!yes) {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question(
      'Type "repair-efi" to back up the current EFI state and create a fresh store: ',
    );
    if (answer.trim() !== 'repair-efi') {
      console.log('EFI repair cancelled.');
      process.exit(0);
    }
  } finally {
    readline.close();
  }
}

const helper = Bun.spawn([
  config.vmHelperPath,
  '--repair-efi-vars',
  efiPath,
], {
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});
const exitCode = await helper.exited;
if (exitCode !== 0) {
  console.error('EFI repair failed. The existing disk image was not modified.');
  process.exitCode = exitCode;
} else {
  console.log('EFI state repaired. The previous EFI store was preserved as a .bak backup.');
  console.log('The next VM start will reuse the new EFI store and the existing disk.img.');
}
