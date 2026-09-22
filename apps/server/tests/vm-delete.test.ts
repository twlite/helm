import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import { loadConfig } from '../src/config';
import {
  ensureVmStopped,
  executeVmDeletion,
  resolveSafeVmDirectory,
} from '../src/vm/vm-delete';

async function fixture() {
  const dataDir = join(tmpdir(), `helm-vm-delete-${randomUUID()}`);
  const config = loadConfig({
    HELM_DATA_DIR: dataDir,
    HELM_VM_HELPER: join(dataDir, 'missing-helper'),
  });
  await mkdir(config.vmDir, { recursive: true });
  return { config, dataDir };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeKnownFiles(config: ReturnType<typeof loadConfig>): Promise<void> {
  await Promise.all([
    writeFile(config.baseImagePath, 'base'),
    writeFile(config.workingImagePath, 'disk'),
    writeFile(config.efiVariablesPath, 'efi'),
    writeFile(config.machineIdentifierPath, 'machine'),
    writeFile(config.provisioningImagePath, 'provisioning'),
    writeFile(config.provisioningEfiVariablesPath, 'provisioning-efi'),
  ]);
}

describe('safe VM deletion', () => {
  it('deletes the active VM state files', async () => {
    const { config, dataDir } = await fixture();
    try {
      await writeKnownFiles(config);
      const result = await executeVmDeletion(config, {
        yes: true,
        isVmRunning: async () => false,
      });

      expect(result.deleted).toEqual([
        'base.img',
        'disk.img',
        'efi-vars.bin',
        'machine-id.bin',
        'provisioning.img',
        'provisioning-efi-vars.bin',
      ]);
      expect(await exists(config.vmDir)).toBe(true);
      expect(await exists(config.baseImagePath)).toBe(false);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('preserves manual backups and unrelated files', async () => {
    const { config, dataDir } = await fixture();
    const preserved = [
      'base-before-guest-setup.img',
      'base-known-good.img',
      'snapshot.backup.img',
      'old.bak',
      'notes.txt',
    ];
    try {
      await writeKnownFiles(config);
      await Promise.all(preserved.map(name => writeFile(join(config.vmDir, name), name)));
      const result = await executeVmDeletion(config, {
        yes: true,
        isVmRunning: async () => false,
      });

      expect(result.plan.preservedBackups).toEqual(preserved.slice(0, 4).sort());
      for (const name of preserved) expect(await exists(join(config.vmDir, name))).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('supports dry-run without deleting anything', async () => {
    const { config, dataDir } = await fixture();
    try {
      await writeKnownFiles(config);
      const result = await executeVmDeletion(config, {
        dryRun: true,
        isVmRunning: async () => false,
      });

      expect(result.dryRun).toBe(true);
      expect(result.deleted).toEqual([]);
      expect(await exists(config.baseImagePath)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('cancels when confirmation is not exact', async () => {
    const { config, dataDir } = await fixture();
    try {
      await writeKnownFiles(config);
      const result = await executeVmDeletion(config, {
        confirm: async () => false,
        isVmRunning: async () => false,
      });

      expect(result.cancelled).toBe(true);
      expect(await exists(config.baseImagePath)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('treats missing state files as a successful no-op', async () => {
    const { config, dataDir } = await fixture();
    try {
      const result = await executeVmDeletion(config, {
        yes: true,
        isVmRunning: async () => false,
      });

      expect(result.deleted).toEqual([]);
      expect(result.plan.files.every(file => !file.exists)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects an unsafe VM directory', async () => {
    const { config, dataDir } = await fixture();
    try {
      expect(() => resolveSafeVmDirectory({ ...config, vmDir: config.dataDir })).toThrow(
        'unsafe VM directory',
      );
      expect(() => resolveSafeVmDirectory({ ...config, vmDir: '/' })).toThrow(
        'unsafe VM directory',
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses to delete while the VM is running', async () => {
    const { config, dataDir } = await fixture();
    try {
      await writeKnownFiles(config);
      await expect(executeVmDeletion(config, {
        yes: true,
        isVmRunning: async () => true,
      })).rejects.toThrow('VM is running. Shut it down before modifying disk images.');
      expect(await exists(config.baseImagePath)).toBe(true);
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('refuses the vm:seal disk mutation guard while the VM is running', async () => {
    const { config, dataDir } = await fixture();
    try {
      await expect(ensureVmStopped(config, async () => true)).rejects.toThrow(
        'VM is running. Shut it down before modifying disk images.',
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
