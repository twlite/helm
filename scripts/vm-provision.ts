import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { loadConfig } from '../apps/server/src/config';
import { virtualizationHelperAvailable } from '../apps/server/src/vm/helper';

function expandPath(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

function usage(): never {
  console.error('Usage: bun run vm:provision [--iso path-to-ubuntu-24.04-arm64.iso]');
  console.error('       bun run vm:provision --resume [--iso path-to-ubuntu-24.04-arm64.iso]');
  console.error('       bun run vm:provision --force --iso path-to-ubuntu-24.04-arm64.iso');
  process.exit(1);
}

const argumentsList = Bun.argv.slice(2);
let force = false;
let resume = false;
let isoInput: string | undefined;

for (let index = 0; index < argumentsList.length; index += 1) {
  const argument = argumentsList[index];
  if (argument === '--') continue;
  if (argument === '--force') {
    force = true;
    continue;
  }
  if (argument === '--resume') {
    resume = true;
    continue;
  }
  if (argument === '--iso' || argument === '--installer-iso') {
    const value = argumentsList[index + 1];
    if (!value || value === '--') {
      console.error(`${argument} requires an installer ISO path.`);
      usage();
    }
    index += 1;
    if (isoInput) {
      console.error('Only one installer ISO path may be supplied.');
      usage();
    }
    isoInput = value;
    continue;
  }
  if (argument === '--help' || argument === '-h') usage();
  if (argument.startsWith('-')) {
    console.error(`Unknown option: ${argument}`);
    usage();
  }
  if (isoInput) {
    console.error('Only one installer ISO path may be supplied.');
    usage();
  }
  isoInput = argument;
}

if (!resume && !isoInput) {
  console.error('Fresh provisioning requires an Ubuntu 24.04 LTS ARM64 installer ISO.');
  usage();
}
if (resume && force) {
  console.error('Cannot combine --resume with --force. Resume never replaces provisioning state.');
  process.exit(1);
}

if (process.platform !== 'darwin') {
  console.error('VM provisioning requires macOS and Apple Virtualization.framework.');
  process.exit(1);
}
if (process.arch !== 'arm64') {
  console.error('VM provisioning currently supports Apple Silicon (arm64) only.');
  process.exit(1);
}

const config = loadConfig();
const isoPath = isoInput ? expandPath(isoInput) : undefined;

if (isoPath) {
  let isoStats;
  try {
    isoStats = await stat(isoPath);
  } catch {
    console.error(`Installer ISO does not exist or is not readable: ${isoPath}`);
    process.exit(1);
  }
  if (!isoStats.isFile() || isoStats.size === 0) {
    console.error(`Installer ISO must be a non-empty regular file: ${isoPath}`);
    process.exit(1);
  }
}

if (resume) {
  for (const [label, path] of [
    ['provisioning disk', config.provisioningImagePath],
    ['provisioning EFI store', config.provisioningEfiVariablesPath],
  ] as const) {
    let state;
    try {
      state = await stat(path);
    } catch {
      console.error(`Cannot resume provisioning: ${label} does not exist at ${path}`);
      process.exit(1);
    }
    if (!state.isFile() || state.size === 0) {
      console.error(`Cannot resume provisioning: ${label} must be a non-empty regular file at ${path}`);
      process.exit(1);
    }
  }
}

if (!virtualizationHelperAvailable(config.vmHelperPath)) {
  console.error(`Signed Virtualization.framework helper not found at ${config.vmHelperPath}`);
  console.error('Run `bun run vm:build` first, then retry provisioning.');
  process.exit(1);
}

await mkdir(dirname(config.provisioningImagePath), { recursive: true });
await mkdir(dirname(config.provisioningEfiVariablesPath), { recursive: true });
await mkdir(dirname(config.provisioningLockPath), { recursive: true });

let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
try {
  lockHandle = await open(config.provisioningLockPath, 'wx');
  await lockHandle.writeFile(JSON.stringify({
    pid: process.pid,
    imagePath: config.provisioningImagePath,
    startedAt: new Date().toISOString(),
  }));
} catch (error) {
  if (lockHandle) await lockHandle.close().catch(() => undefined);
  if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
    console.error(`Another Helm provisioning run is active or left a lock at ${config.provisioningLockPath}`);
  } else {
    console.error(`Unable to create the provisioning lock: ${error instanceof Error ? error.message : String(error)}`);
  }
  process.exit(1);
}

if (resume) {
  console.error('Helm provisioning resume: existing provisioning disk and EFI state will be reused.');
  if (isoPath) {
    console.error('The supplied Ubuntu ARM64 ISO will be attached read-only as optional installer media.');
  }
  console.error('A native macOS VM window will open. Continue the installation, shut down the VM, close the window, then run `bun run vm:seal`.');
} else {
  console.error('Helm provisioning contract: Ubuntu 24.04 LTS ARM64 installer ISO.');
  console.error('The ISO architecture is intentionally not introspected; provide the official ARM64 image.');
  console.error('A native macOS VM window will open. Install Ubuntu into the empty Helm disk, shut down the VM, close the window, then run `bun run vm:seal`.');
}

const helperArguments = [
  '--provision',
  ...(resume ? ['--resume'] : []),
  ...(isoPath ? ['--installer-iso', isoPath] : []),
  '--installation-image', config.provisioningImagePath,
  '--efi-vars', config.provisioningEfiVariablesPath,
  '--machine-id', config.machineIdentifierPath,
  '--runtime-share', config.runtimeDir,
  '--runtime-tag', config.runtimeTag,
  '--cpus', String(config.vmCpus),
  '--memory-mib', String(config.vmMemoryMb),
  '--display-width', '1280',
  '--display-height', '800',
  ...(force ? ['--force'] : []),
];

let exitCode = 1;
try {
  const processHandle = Bun.spawn([config.vmHelperPath, ...helperArguments], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  exitCode = await processHandle.exited;
} catch (error) {
  console.error(`Unable to launch the VM provisioning helper: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (lockHandle) await lockHandle.close().catch(() => undefined);
  await unlink(config.provisioningLockPath).catch(() => undefined);
}

process.exitCode = exitCode;
