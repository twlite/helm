import { lstat, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { HelmConfig } from '../config';

export const VM_STATE_FILE_NAMES = [
  'base.img',
  'disk.img',
  'efi-vars.bin',
  'machine-id.bin',
  'provisioning.img',
  'provisioning-efi-vars.bin',
] as const;

const ACTIVE_VM_STATES = new Set(['running', 'starting', 'stopping']);

export class VmDeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VmDeleteError';
  }
}

export interface VmDeletionEntry {
  name: typeof VM_STATE_FILE_NAMES[number];
  path: string;
  exists: boolean;
  sizeBytes?: number;
}

export interface VmDeletionPlan {
  vmDirectory: string;
  files: VmDeletionEntry[];
  preservedBackups: string[];
}

export interface VmDeletionResult {
  plan: VmDeletionPlan;
  deleted: string[];
  cancelled: boolean;
  dryRun: boolean;
}

export interface VmDeletionOptions {
  yes?: boolean;
  dryRun?: boolean;
  confirm?: () => Promise<boolean>;
  isVmRunning?: () => Promise<boolean>;
  onPlan?: (plan: VmDeletionPlan) => void;
}

function isPathWithin(parent: string, child: string): boolean {
  const childRelativePath = relative(parent, child);
  return childRelativePath !== ''
    && childRelativePath !== '..'
    && !childRelativePath.startsWith(`..${sep}`)
    && !childRelativePath.startsWith(sep);
}

function configuredVmArtifactPaths(config: HelmConfig): Array<[string, string]> {
  return [
    [config.baseImagePath, 'base.img'],
    [config.workingImagePath, 'disk.img'],
    [config.efiVariablesPath, 'efi-vars.bin'],
    [config.machineIdentifierPath, 'machine-id.bin'],
    [config.provisioningImagePath, 'provisioning.img'],
    [config.provisioningEfiVariablesPath, 'provisioning-efi-vars.bin'],
  ];
}

/**
 * Validate and resolve the only directory this command is allowed to touch.
 * The exact artifact paths are checked as well so an environment override
 * cannot cause this command to delete a file outside the configured VM dir.
 */
export function resolveSafeVmDirectory(config: HelmConfig): string {
  const rawVmDirectory = config.vmDir.trim();
  const rawDataDirectory = config.dataDir.trim();
  if (!rawVmDirectory) {
    throw new VmDeleteError('Refusing to delete VM state: the configured VM directory is empty.');
  }
  if (!rawDataDirectory) {
    throw new VmDeleteError('Refusing to delete VM state: the configured application-support directory is empty.');
  }

  const vmDirectory = resolve(rawVmDirectory);
  const dataDirectory = resolve(config.dataDir);
  const homeDirectory = resolve(homedir());

  if (
    dataDirectory === '/'
    || dataDirectory === homeDirectory
    || vmDirectory === '/'
    || vmDirectory === homeDirectory
    || vmDirectory === dataDirectory
    || !isPathWithin(dataDirectory, vmDirectory)
    || basename(vmDirectory) !== 'vm'
  ) {
    throw new VmDeleteError(
      `Refusing to delete VM state: unsafe VM directory ${vmDirectory}. `
        + 'It must be the vm directory inside Helm application support.',
    );
  }

  const expectedVmDirectory = resolve(join(dataDirectory, 'vm'));
  if (vmDirectory !== expectedVmDirectory) {
    throw new VmDeleteError(
      `Refusing to delete VM state: ${vmDirectory} is not the configured Helm VM directory.`,
    );
  }

  for (const [configuredPath, expectedName] of configuredVmArtifactPaths(config)) {
    const resolvedPath = resolve(configuredPath);
    const expectedPath = join(vmDirectory, expectedName);
    if (resolvedPath !== expectedPath) {
      throw new VmDeleteError(
        `Refusing to delete VM state: configured ${expectedName} path is outside the safe VM directory.`,
      );
    }
  }

  return vmDirectory;
}

async function assertSafeDirectoryEntry(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new VmDeleteError(`Refusing to delete VM state: ${label} is a symbolic link.`);
    }
    if (!info.isDirectory()) {
      throw new VmDeleteError(`Refusing to delete VM state: ${label} is not a directory.`);
    }
  } catch (error) {
    if (error instanceof VmDeleteError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw new VmDeleteError(`Unable to inspect the Helm VM directory: ${String(error)}`);
  }
}

async function assertNoSymlinkedDataDirectory(config: HelmConfig): Promise<void> {
  const configuredDataDirectory = resolve(config.dataDir);
  try {
    const physicalDataDirectory = resolve(await realpath(configuredDataDirectory));
    const physicalParentDirectory = resolve(await realpath(dirname(configuredDataDirectory)));
    const expectedPhysicalDataDirectory = join(
      physicalParentDirectory,
      basename(configuredDataDirectory),
    );
    if (physicalDataDirectory !== expectedPhysicalDataDirectory) {
      throw new VmDeleteError(
        `Refusing to delete VM state: Helm application-support directory is a symbolic link.`,
      );
    }
  } catch (error) {
    if (error instanceof VmDeleteError) throw error;
    if (errorCode(error) === 'ENOENT') return;
    throw new VmDeleteError(`Unable to inspect the Helm application-support directory: ${String(error)}`);
  }
}

async function inspectDeletionEntry(
  vmDirectory: string,
  name: typeof VM_STATE_FILE_NAMES[number],
): Promise<VmDeletionEntry> {
  const path = join(vmDirectory, name);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) {
      throw new VmDeleteError(`Refusing to delete VM state: ${name} is a symbolic link.`);
    }
    if (!info.isFile()) {
      throw new VmDeleteError(`Refusing to delete VM state: ${name} is not a regular file.`);
    }
    return { name, path, exists: true, sizeBytes: info.size };
  } catch (error) {
    if (error instanceof VmDeleteError) throw error;
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { name, path, exists: false };
    }
    throw new VmDeleteError(`Unable to inspect ${name}: ${String(error)}`);
  }
}

function isManualBackup(name: string): boolean {
  return name === 'base-before-guest-setup.img'
    || name === 'base-known-good.img'
    || name.endsWith('.backup.img')
    || name.endsWith('.bak');
}

export async function prepareVmDeletion(config: HelmConfig): Promise<VmDeletionPlan> {
  const vmDirectory = resolveSafeVmDirectory(config);
  await assertNoSymlinkedDataDirectory(config);
  await assertSafeDirectoryEntry(vmDirectory, 'the VM directory');

  let directoryEntries: Array<{ name: string }> = [];
  try {
    directoryEntries = await readdir(vmDirectory, {
      withFileTypes: true,
      encoding: 'utf8',
    }) as Array<{ name: string }>;
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw new VmDeleteError(`Unable to inspect the Helm VM directory: ${String(error)}`);
    }
  }

  const files = await Promise.all(
    VM_STATE_FILE_NAMES.map(name => inspectDeletionEntry(vmDirectory, name)),
  );

  return {
    vmDirectory,
    files,
    preservedBackups: directoryEntries
      .filter(entry => entry.name !== '.' && entry.name !== '..' && isManualBackup(entry.name))
      .map(entry => entry.name)
      .sort(),
  };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String(error.code)
    : undefined;
}

async function processIsAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw new VmDeleteError(`Unable to verify process ${pid}; refusing to delete VM state.`);
  }
}

async function provisioningProcessIsRunning(config: HelmConfig): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(config.provisioningLockPath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw new VmDeleteError('Unable to inspect the provisioning lock; refusing to delete VM state.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch {
    throw new VmDeleteError('Unable to verify the provisioning lock; refusing to delete VM state.');
  }

  const pid = parsed && typeof parsed === 'object' && 'pid' in parsed ? parsed.pid : undefined;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) {
    throw new VmDeleteError('Unable to verify the provisioning lock; refusing to delete VM state.');
  }
  return processIsAlive(pid);
}

async function nativeVmHostIsRunning(config: HelmConfig): Promise<boolean> {
  if (process.platform === 'win32') return false;

  let processList: Bun.Subprocess;
  try {
    processList = Bun.spawn(['ps', '-axo', 'pid=,command='], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
  } catch {
    throw new VmDeleteError('Unable to inspect native VM host processes; refusing to delete VM state.');
  }

  if (!processList.stdout || typeof processList.stdout === 'number') {
    throw new VmDeleteError('Unable to inspect native VM host processes; refusing to delete VM state.');
  }

  const [exitCode, output] = await Promise.all([
    processList.exited,
    new Response(processList.stdout).text(),
  ]);
  if (exitCode !== 0) {
    throw new VmDeleteError('Unable to inspect native VM host processes; refusing to delete VM state.');
  }

  const helperPath = resolve(config.vmHelperPath);
  const helperName = basename(helperPath);
  for (const line of output.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/u);
    if (!match || Number(match[1]) === process.pid) continue;
    const command = match[2];
    if (command.includes(helperPath) || command.split(/\s+/u).some(token => token === helperName)) {
      return true;
    }
  }
  return false;
}

async function serverVmIsRunning(config: HelmConfig): Promise<boolean> {
  const serverUrl = process.env.HELM_SERVER_URL ?? `http://${config.host}:${config.port}`;
  const response = await fetch(`${serverUrl}/api/vm/status`, {
    signal: AbortSignal.timeout(750),
  }).catch(() => undefined);
  if (!response?.ok) return false;

  const body = await response.json().catch(() => undefined) as { state?: unknown } | undefined;
  return typeof body?.state === 'string' && ACTIVE_VM_STATES.has(body.state);
}

export async function isVmRunning(config: HelmConfig): Promise<boolean> {
  if (await serverVmIsRunning(config)) return true;
  if (await provisioningProcessIsRunning(config)) return true;
  return nativeVmHostIsRunning(config);
}

export async function ensureVmStopped(
  config: HelmConfig,
  check: () => Promise<boolean> = () => isVmRunning(config),
): Promise<void> {
  if (await check()) {
    throw new VmDeleteError('VM is running. Stop it before deleting VM state.');
  }
}

export async function deleteVmState(plan: VmDeletionPlan): Promise<string[]> {
  const deleted: string[] = [];
  for (const file of plan.files) {
    if (!file.exists) continue;
    try {
      await unlink(file.path);
      deleted.push(file.name);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue;
      throw new VmDeleteError(`Unable to delete ${file.name}: ${String(error)}`);
    }
  }
  return deleted;
}

export async function executeVmDeletion(
  config: HelmConfig,
  options: VmDeletionOptions = {},
): Promise<VmDeletionResult> {
  const plan = await prepareVmDeletion(config);
  await ensureVmStopped(config, options.isVmRunning);
  options.onPlan?.(plan);

  if (options.dryRun) {
    return { plan, deleted: [], cancelled: false, dryRun: true };
  }

  const confirmed = options.yes === true || (options.confirm ? await options.confirm() : false);
  if (!confirmed) {
    return { plan, deleted: [], cancelled: true, dryRun: false };
  }

  // The confirmation prompt can leave enough time for a VM to be started in
  // another terminal, so check once more immediately before unlinking files.
  await ensureVmStopped(config, options.isVmRunning);
  const deleted = await deleteVmState(plan);
  return { plan, deleted, cancelled: false, dryRun: false };
}

function formatSize(sizeBytes: number | undefined): string {
  if (sizeBytes === undefined) return 'missing';
  if (sizeBytes >= 1024 ** 3) return `${Math.round(sizeBytes / (1024 ** 3))} GB`;
  if (sizeBytes >= 1024 ** 2) return `${Math.round(sizeBytes / (1024 ** 2))} MB`;
  if (sizeBytes >= 1024) return `${Math.round(sizeBytes / 1024)} KB`;
  return `${sizeBytes} B`;
}

export function formatVmDeletionPlan(plan: VmDeletionPlan): string {
  const lines = ['Helm VM deletion', '', 'Will delete:'];
  for (const file of plan.files) {
    lines.push(`  ${file.name.padEnd(30)} ${formatSize(file.sizeBytes)}`);
  }
  lines.push('', 'Preserved:');
  if (plan.preservedBackups.length === 0) {
    lines.push('  (no manual backups found)');
  } else {
    for (const backup of plan.preservedBackups) lines.push(`  ${backup}`);
  }
  return lines.join('\n');
}
