import { existsSync } from 'node:fs';
import { arch, platform } from 'node:process';
import { loadConfig } from '../apps/server/src/config';
import { virtualizationHelperAvailable } from '../apps/server/src/vm/helper';

const config = loadConfig();
const checks: Array<{ label: string; ok: boolean; detail: string }> = [];

const add = (label: string, ok: boolean, detail: string) => checks.push({ label, ok, detail });

add('macOS supported', platform === 'darwin', platform === 'darwin' ? process.platform : `running on ${platform}`);
add('Apple Silicon detected', platform === 'darwin' && arch === 'arm64', `${platform}/${arch}`);
add('virtualization helper built', existsSync(config.vmHelperPath), config.vmHelperPath);
add('virtualization entitlement present', virtualizationHelperAvailable(config.vmHelperPath), config.vmHelperPath);
add('base image exists', existsSync(config.baseImagePath), config.baseImagePath);
add('working image exists', existsSync(config.workingImagePath), config.workingImagePath);
add('EFI variables exist', existsSync(config.efiVariablesPath), config.efiVariablesPath);
add('guest runtime bundle built', existsSync(`${config.runtimeDir}/guest/helm-guest.js`), `${config.runtimeDir}/guest/helm-guest.js`);

for (const check of checks) {
  console.log(`${check.ok ? 'OK ' : 'MISS'} ${check.label}: ${check.detail}`);
}

if (checks.some(check => !check.ok)) {
  console.error('\nHelm VM diagnostics found missing or unsupported prerequisites.');
  process.exitCode = 1;
}
