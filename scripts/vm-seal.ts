import { copyFile, link, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../apps/server/src/config';
import {
  ensureVmStopped,
  VM_RUNNING_DISK_MUTATION_MESSAGE,
} from '../apps/server/src/vm/vm-delete';

type FileState = 'missing' | 'invalid' | 'valid';

function usage(): never {
  console.error('Usage: bun run vm:seal [--force]');
  process.exit(1);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

async function inspectFile(path: string): Promise<FileState> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return 'invalid';
    return 'valid';
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 'missing';
    return 'invalid';
  }
}

async function ensureProvisioningFinished(lockPath: string): Promise<void> {
  let contents: string;
  try {
    contents = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return;
    throw new Error(`Unable to inspect the provisioning lock at ${lockPath}: ${String(error)}`);
  }

  let lock: unknown;
  try {
    lock = JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`The provisioning lock at ${lockPath} is invalid. Verify no provisioning run is active, then remove the stale lock.`);
  }

  const pid = lock && typeof lock === 'object' && 'pid' in lock ? lock.pid : undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
    throw new Error(`The provisioning lock at ${lockPath} has no valid owner. Verify no provisioning run is active, then remove the stale lock.`);
  }

  try {
    process.kill(pid, 0);
    throw new Error(`A provisioning run is still active (pid ${pid}). Shut it down and close its window before sealing.`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('A provisioning run is still active')) {
      throw error;
    }
    if (errorCode(error) !== 'ESRCH') {
      throw new Error(`Unable to verify provisioning process ${pid}. Refusing to seal while the lock is ambiguous.`);
    }
    await unlink(lockPath);
  }
}

async function atomicCopy(sourcePath: string, targetPath: string, replaceExisting: boolean): Promise<void> {
  const temporaryPath = `${targetPath}.${randomUUID()}.tmp`;
  try {
    await copyFile(sourcePath, temporaryPath);
    if (replaceExisting) {
      await rename(temporaryPath, targetPath);
    } else {
      // A hard-link install gives the first-run path no-replace semantics:
      // if another process creates the target after our initial check, link()
      // fails instead of silently overwriting it.
      await link(temporaryPath, targetPath);
      await unlink(temporaryPath);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

async function removeFileIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
  }
}


const argumentsList = Bun.argv.slice(2);
let force = false;
for (const argument of argumentsList) {
  if (argument === '--force') {
    force = true;
    continue;
  }
  if (argument === '--help' || argument === '-h') usage();
  console.error(`Unknown option: ${argument}`);
  usage();
}

const config = loadConfig();
const sourcePath = resolve(config.provisioningImagePath);
const basePath = resolve(config.baseImagePath);
const provisioningEfiPath = resolve(config.provisioningEfiVariablesPath);
const normalEfiPath = resolve(config.efiVariablesPath);

if (
  sourcePath === basePath
  || sourcePath === provisioningEfiPath
  || sourcePath === normalEfiPath
  || provisioningEfiPath === normalEfiPath
  || provisioningEfiPath === basePath
  || normalEfiPath === basePath
) {
  console.error('The provisioning disk, EFI stores, and base image must be different files.');
  process.exit(1);
}

try {
  await ensureVmStopped(config);
  await ensureProvisioningFinished(resolve(config.provisioningLockPath));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const sourceState = await inspectFile(sourcePath);
if (sourceState !== 'valid') {
  console.error(`No valid installed provisioning disk was found at ${sourcePath}`);
  console.error('Run `bun run vm:provision --iso /path/to/ubuntu-24.04-arm64.iso` first.');
  process.exit(1);
}

const provisioningEfiState = await inspectFile(provisioningEfiPath);
if (provisioningEfiState !== 'valid') {
  console.error(`The provisioning EFI store is missing or invalid at ${provisioningEfiPath}.`);
  console.error('Run the interactive provisioning workflow again before sealing.');
  process.exit(1);
}

const baseState = await inspectFile(basePath);
if (baseState === 'invalid') {
  console.error(`The existing base image path is not a valid regular file: ${basePath}`);
  process.exit(1);
}
if (baseState === 'valid' && !force) {
  console.error(`A base image already exists at ${basePath}. Use --force to replace it.`);
  process.exit(1);
}

const normalArtifacts = [
  { label: 'working disk', path: resolve(config.workingImagePath) },
  { label: 'normal EFI store', path: normalEfiPath },
  { label: 'normal machine identifier', path: resolve(config.machineIdentifierPath) },
];
const existingNormalArtifacts: string[] = [];
let normalEfiState: FileState = 'missing';
for (const artifact of normalArtifacts) {
  const state = await inspectFile(artifact.path);
  if (artifact.path === normalEfiPath) normalEfiState = state;
  if (state === 'invalid') {
    console.error(`The existing ${artifact.label} path is not a valid regular file: ${artifact.path}`);
    process.exit(1);
  }
  if (state === 'valid') existingNormalArtifacts.push(artifact.path);
}
const normalStateOtherThanMachineIdentifier = existingNormalArtifacts.filter(
  path => path !== resolve(config.machineIdentifierPath),
);
// Fresh provisioning persists the VM identity so --resume can use the same
// hardware identity. Before the first seal, that lone file is provisioning
// state rather than an initialized normal VM artifact.
if (normalStateOtherThanMachineIdentifier.length > 0 && !force) {
  console.error('Normal VM state already exists. Refusing to seal over it without resetting the state.');
  console.error('Stop the normal VM, then rerun `bun run vm:seal --force` to replace the base and clear stale working state.');
  process.exit(1);
}
await mkdir(dirname(basePath), { recursive: true });
if (normalEfiPath === basePath || provisioningEfiPath === basePath) {
  console.error('The EFI store and base image must be stored at different paths.');
  process.exit(1);
}

try {
  await ensureVmStopped(config);
  await atomicCopy(sourcePath, basePath, baseState === 'valid');
  await ensureVmStopped(config);
  await atomicCopy(provisioningEfiPath, normalEfiPath, normalEfiState === 'valid');
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message === VM_RUNNING_DISK_MUTATION_MESSAGE
    ? message
    : `Unable to seal the installed disk: ${message}`);
  process.exit(1);
}

if (force) {
  try {
    await ensureVmStopped(config);
    for (const artifact of normalArtifacts) {
      if (artifact.path === normalEfiPath || artifact.path === resolve(config.machineIdentifierPath)) continue;
      await removeFileIfPresent(artifact.path);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message === VM_RUNNING_DISK_MUTATION_MESSAGE
      ? message
      : `Base image sealed, but existing working state could not be cleared: ${message}`);
    process.exit(1);
  }
}

console.log(`${baseState === 'valid' ? 'Replaced' : 'Created'} Helm base image: ${basePath}`);
console.log(`Copied provisioning EFI state to: ${normalEfiPath}`);
console.log(`Source provisioning disk retained: ${sourcePath}`);
if (force && existingNormalArtifacts.length > 0) {
  console.log('Cleared existing normal working disk; the next VM start will use the sealed base image and preserved VM identity.');
}
