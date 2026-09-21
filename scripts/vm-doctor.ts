import { statSync } from 'node:fs';
import { arch, platform } from 'node:process';
import { loadConfig } from '../apps/server/src/config';
import { virtualizationHelperAvailable } from '../apps/server/src/vm/helper';

type CheckStatus = 'OK' | 'WARN' | 'WAIT' | 'MISS';

interface Check {
  label: string;
  status: CheckStatus;
  detail: string;
  blocking: boolean;
}

const config = loadConfig();
const checks: Check[] = [];

function add(label: string, status: CheckStatus, detail: string, blocking = false): void {
  checks.push({ label, status, detail, blocking });
}

function inspectFile(path: string): 'missing' | 'invalid' | 'valid' {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size === 0) return 'invalid';
    return 'valid';
  } catch {
    return 'missing';
  }
}

const macOSSupported = platform === 'darwin';
add('macOS supported', macOSSupported ? 'OK' : 'MISS', macOSSupported ? platform : `running on ${platform}`, !macOSSupported);

const appleSilicon = macOSSupported && arch === 'arm64';
add('Apple Silicon detected', appleSilicon ? 'OK' : 'MISS', `${platform}/${arch}`, !appleSilicon);

const helperState = inspectFile(config.vmHelperPath);
add(
  'virtualization helper built',
  helperState === 'valid' ? 'OK' : 'MISS',
  helperState === 'valid' ? config.vmHelperPath : `missing or invalid: ${config.vmHelperPath}`,
  helperState !== 'valid',
);

const entitlementPresent = helperState === 'valid' && virtualizationHelperAvailable(config.vmHelperPath);
add(
  'virtualization entitlement present',
  helperState !== 'valid' ? 'WAIT' : entitlementPresent ? 'OK' : 'MISS',
  helperState !== 'valid' ? 'build the helper first' : config.vmHelperPath,
  helperState === 'valid' && !entitlementPresent,
);

const baseState = inspectFile(config.baseImagePath);
add(
  'base image exists',
  baseState === 'valid' ? 'OK' : baseState === 'missing' ? 'WAIT' : 'MISS',
  baseState === 'valid'
    ? config.baseImagePath
    : baseState === 'missing'
      ? `run bun run vm:provision /path/to/ubuntu-24.04-arm64.iso, then bun run vm:seal (${config.baseImagePath})`
      : `missing or invalid: ${config.baseImagePath}`,
  baseState === 'invalid',
);

const workingState = inspectFile(config.workingImagePath);
add(
  'working image exists',
  workingState === 'valid' ? 'OK' : workingState === 'missing' ? 'WAIT' : 'MISS',
  workingState === 'valid'
    ? config.workingImagePath
    : workingState === 'missing'
      ? 'created automatically from base.img on the first VM start'
      : `missing or invalid: ${config.workingImagePath}`,
  workingState === 'invalid',
);

const efiState = inspectFile(config.efiVariablesPath);
add(
  'EFI variables exist',
  efiState === 'valid' ? 'OK' : efiState === 'missing' ? 'WAIT' : 'MISS',
  efiState === 'valid'
    ? config.efiVariablesPath
    : efiState === 'missing'
      ? 'created automatically during the first VM start'
      : `missing or invalid: ${config.efiVariablesPath}`,
  efiState === 'invalid',
);

const guestRuntimePath = `${config.runtimeDir}/guest/helm-guest.js`;
const guestRuntimeState = inspectFile(guestRuntimePath);
add(
  'guest runtime bundle built',
  guestRuntimeState === 'valid' ? 'OK' : 'WARN',
  guestRuntimeState === 'valid' ? guestRuntimePath : `build with bun run guest:build: ${guestRuntimePath}`,
);

for (const check of checks) {
  console.log(`${check.status.padEnd(5)} ${check.label}: ${check.detail}`);
}

if (checks.some(check => check.blocking)) {
  console.error('\nHelm VM diagnostics found blocking prerequisites.');
  process.exitCode = 1;
} else {
  console.log('\nHelm VM diagnostics found no blocking prerequisites.');
}
