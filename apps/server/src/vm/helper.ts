import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

/** A helper is usable for Virtualization.framework only when its entitlement is present. */
export function virtualizationHelperAvailable(path: string): boolean {
  if (process.platform !== 'darwin' || !existsSync(path)) return false;
  try {
    const result = spawnSync('/usr/bin/codesign', ['-d', '--entitlements', '-', '--xml', path], {
      encoding: 'utf8',
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return result.status === 0 && output.includes('com.apple.security.virtualization');
  } catch {
    return false;
  }
}
