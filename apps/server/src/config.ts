import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function expandHome(value: string): string {
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

const defaultDataDir =
  process.platform === 'darwin'
    ? join(homedir(), 'Library', 'Application Support', 'Helm')
    : join(homedir(), '.local', 'share', 'helm');

function numberFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface HelmConfig {
  host: string;
  port: number;
  dataDir: string;
  databasePath: string;
  runtimeDir: string;
  baseImagePath: string;
  workingImagePath: string;
  efiVariablesPath: string;
  vmHelperPath: string;
  vmMemoryMb: number;
  vmCpus: number;
  guestHost: string;
  guestPort: number;
  maxSteps: number;
  maxRepeatedAction: number;
  maxConsecutiveFailures: number;
  toolTimeoutMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HelmConfig {
  const dataDir = expandHome(env.HELM_DATA_DIR ?? defaultDataDir);
  const vmDir = join(dataDir, 'vm');
  return {
    host: env.HELM_HOST ?? '127.0.0.1',
    port: numberFromEnv(env, 'HELM_PORT', 8787),
    dataDir,
    databasePath: env.HELM_DATABASE_PATH
      ? expandHome(env.HELM_DATABASE_PATH)
      : join(dataDir, 'helm.sqlite'),
    runtimeDir: env.HELM_RUNTIME_DIR
      ? expandHome(env.HELM_RUNTIME_DIR)
      : join(dataDir, 'runtime'),
    baseImagePath: expandHome(env.HELM_VM_BASE_IMAGE ?? join(vmDir, 'base.img')),
    workingImagePath: expandHome(env.HELM_VM_WORKING_IMAGE ?? join(vmDir, 'disk.img')),
    efiVariablesPath: expandHome(env.HELM_VM_EFI_VARS ?? join(vmDir, 'efi-vars.bin')),
    vmHelperPath: expandHome(
      env.HELM_VM_HELPER ?? join(repositoryRoot, 'native', 'helm-vm-host', '.build', 'release', 'helm-vm-host'),
    ),
    vmMemoryMb: numberFromEnv(env, 'HELM_VM_MEMORY_MB', 4096),
    vmCpus: numberFromEnv(env, 'HELM_VM_CPUS', 4),
    guestHost: env.HELM_GUEST_HOST ?? '127.0.0.1',
    guestPort: numberFromEnv(env, 'HELM_GUEST_PORT', 4242),
    maxSteps: numberFromEnv(env, 'HELM_MAX_STEPS', 32),
    maxRepeatedAction: numberFromEnv(env, 'HELM_MAX_REPEATED_ACTION', 3),
    maxConsecutiveFailures: numberFromEnv(env, 'HELM_MAX_CONSECUTIVE_FAILURES', 3),
    toolTimeoutMs: numberFromEnv(env, 'HELM_TOOL_TIMEOUT_MS', 30_000),
  };
}
