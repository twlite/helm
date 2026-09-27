import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';
import { guestMethodSchemas, guestProtocolContractJson } from '@helm/shared';
import type { GuestBuildManifest } from '@helm/shared';

import { loadConfig } from '../src/config';
import { EventHub } from '../src/events';
import { sha256Hex } from '../src/vm/guest-build-identity';
import {
  VmController,
  type VmControllerDependencies,
} from '../src/vm/vm-controller';

type HostRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

function fixtureConfig() {
  const dataDir = join(tmpdir(), 'helm-vm-controller-' + randomUUID());
  const config = loadConfig({
    HELM_DATA_DIR: dataDir,
    HELM_VM_HELPER: join(dataDir, 'fake-helm-vm-host'),
  });
  const guestDirectory = join(config.runtimeDir, 'guest');
  mkdirSync(guestDirectory, { recursive: true });
  const bundle = Buffer.from('fixture guest bundle');
  writeFileSync(join(guestDirectory, 'helm-guest.js'), bundle);
  const manifest: GuestBuildManifest = {
    manifestVersion: 1,
    runtime: 'helm-guest',
    buildId: sha256Hex('fixture guest source build'),
    protocolVersion: 2,
    protocolContractSha256: sha256Hex(guestProtocolContractJson()),
    bundleSha256: sha256Hex(bundle),
    bundleSizeBytes: bundle.byteLength,
    bunVersion: 'fixture',
  };
  writeFileSync(join(guestDirectory, 'helm-guest.manifest.json'), JSON.stringify(manifest));
  return { config, manifest };
}

class FakeHostProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: string[] = [];
  readonly guestServerIds: string[] = [];
  nativeState: 'stopped' | 'running' = 'stopped';
  killed = false;
  killCommandCount = -1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private inputBuffer = '';

  constructor(
    private readonly handshakeReady: boolean,
    private readonly failedGuestMethod?: string,
    private readonly handshakeOverride: Record<string, unknown> = {},
  ) {
    super();
    const fixture = fixtureConfig();
    this.config = fixture.config;
    this.guestManifest = fixture.manifest;
    this.stdin.setEncoding('utf8');
    this.stdin.on('data', chunk => {
      this.inputBuffer += String(chunk);
      let newlineIndex = this.inputBuffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = this.inputBuffer.slice(0, newlineIndex);
        this.inputBuffer = this.inputBuffer.slice(newlineIndex + 1);
        if (line.trim()) this.handle(JSON.parse(line) as HostRequest);
        newlineIndex = this.inputBuffer.indexOf('\n');
      }
    });
  }

  readonly config: ReturnType<typeof loadConfig>;
  readonly guestManifest: GuestBuildManifest;

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.killCommandCount = this.commands.length;
    this.signalCode = signal;
    this.stdin.end();
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', null, signal);
    return true;
  }

  private handle(request: HostRequest): void {
    this.commands.push(request.method);
    switch (request.method) {
      case 'vm.start':
        this.nativeState = 'running';
        this.respond(request.id, true, { state: 'running' });
        return;
      case 'vm.status':
        this.respond(request.id, true, { state: this.nativeState });
        return;
      case 'vm.stop':
      case 'vm.force-stop':
        this.nativeState = 'stopped';
        this.respond(request.id, true, { state: 'stopped' });
        return;
      case 'vm.reset':
        if (this.nativeState === 'running') {
          this.respond(
            request.id,
            false,
            undefined,
            {
              code: 'vm_running',
              message: 'VM is running. Shut it down before modifying disk images.',
            },
          );
        } else {
          this.respond(request.id, true, { state: 'stopped' });
        }
        return;
      case 'vm.guestRequest': {
        const guestRequest = request.params as { id?: string; method?: string } | undefined;
        const guestId = guestRequest?.id ?? 'guest-test';
        if (guestRequest?.method === 'guest.handshake' && !this.handshakeReady) {
          this.respond(request.id, true, {
            id: guestId,
            ok: false,
            error: { code: 'guest_unavailable', message: 'helm-guest is not ready' },
          });
          return;
        }
        if (guestRequest?.method === this.failedGuestMethod) {
          this.respond(request.id, true, {
            id: guestId,
            ok: false,
            error: { code: 'guest_operation_failed', message: 'The guest operation failed without disconnecting.' },
          });
          return;
        }
        const guestParams = guestRequest?.params as { serverId?: string } | undefined;
        if (guestRequest?.method === 'guest.handshake' && guestParams?.serverId) {
          this.guestServerIds.push(guestParams.serverId);
        }
        this.respond(request.id, true, {
          id: guestId,
          ok: true,
          result: guestRequest?.method === 'desktop.screenshot'
            ? {}
            : {
              runtime: 'helm-guest',
              protocolVersion: this.guestManifest.protocolVersion,
              buildId: this.guestManifest.buildId,
              protocolContractSha256: this.guestManifest.protocolContractSha256,
              bundleSha256: this.guestManifest.bundleSha256,
              serverId: guestParams?.serverId,
              methods: Object.keys(guestMethodSchemas),
              ...this.handshakeOverride,
            },
        });
        return;
      }
      default:
        this.respond(request.id, false, undefined, {
          code: 'unknown_method',
          message: 'Unknown test host method',
        });
    }
  }

  private respond(
    id: string,
    ok: boolean,
    result?: unknown,
    error?: { code: string; message: string },
  ): void {
    this.stdout.write(JSON.stringify({
      id,
      ok,
      ...(result === undefined ? {} : { result }),
      ...(error === undefined ? {} : { error }),
    }) + '\n');
  }
}

function makeController(fake: FakeHostProcess) {
  const spawnHost = (() => fake) as NonNullable<VmControllerDependencies['spawn']>;
  return new VmController(
    fake.config,
    new EventHub(),
    undefined,
    {
      helperAvailable: true,
      spawn: spawnHost,
      guestSourceRoot: fake.config.dataDir,
      guestRetryAttempts: 1,
      guestRetryDelayMs: 0,
      hostCommandTimeoutMs: 1_000,
      childTerminationTimeoutMs: 1_000,
    },
  );
}

describe('VM lifecycle safety', () => {
  it('verifies the loaded guest bundle and reuses a stable server identity on reconnect', async () => {
    const fake = new FakeHostProcess(true);
    const vm = makeController(fake);

    try {
      await vm.start();
      const firstStatus = await vm.status();
      expect(firstStatus.guestIdentity).toMatchObject({
        state: 'verified',
        sourceVerified: false,
        runningBuildId: fake['guestManifest'].buildId,
        runningBundleSha256: fake['guestManifest'].bundleSha256,
      });
      await vm.reconnect(true);
      const nextStatus = await vm.status();
      expect(fake.guestServerIds.length).toBe(2);
      expect(fake.guestServerIds[0]).toBe(firstStatus.guestIdentity?.serverId);
      expect(fake.guestServerIds[1]).toBe(firstStatus.guestIdentity?.serverId);
      expect(nextStatus.guestIdentity?.serverId).toBe(firstStatus.guestIdentity?.serverId);
    } finally {
      await vm.close();
    }
  });

  it('rejects a running guest whose embedded build differs from the on-disk manifest', async () => {
    const fake = new FakeHostProcess(true, undefined, { buildId: '0'.repeat(64) });
    const vm = makeController(fake);

    try {
      await expect(vm.start()).rejects.toMatchObject({ code: 'GUEST_BUILD_IDENTITY_MISMATCH' });
      await expect(vm.status()).resolves.toMatchObject({
        state: 'running',
        guestConnected: false,
        guestIdentity: {
          state: 'mismatch',
          runningBuildId: '0'.repeat(64),
          error: { code: 'GUEST_BUILD_IDENTITY_MISMATCH' },
        },
      });
      expect(fake.commands.filter(command => command === 'vm.guestRequest').length).toBe(1);
      expect(fake.killed).toBe(false);
    } finally {
      await vm.close();
    }
  });

  it('rejects a guest handshake echoed for a different server process', async () => {
    const fake = new FakeHostProcess(true, undefined, {
      serverId: '00000000-0000-4000-8000-000000000099',
    });
    const vm = makeController(fake);

    try {
      await expect(vm.start()).rejects.toMatchObject({ code: 'GUEST_SERVER_ID_MISMATCH' });
      await expect(vm.status()).resolves.toMatchObject({
        guestConnected: false,
        guestIdentity: { state: 'mismatch', error: { code: 'GUEST_SERVER_ID_MISMATCH' } },
      });
    } finally {
      await vm.close();
    }
  });

  it('rejects a guest that reports a different method set', async () => {
    const fake = new FakeHostProcess(true, undefined, { methods: ['guest.handshake'] });
    const vm = makeController(fake);

    try {
      await expect(vm.start()).rejects.toMatchObject({ code: 'GUEST_TOOL_CONTRACT_MISMATCH' });
      await expect(vm.status()).resolves.toMatchObject({
        guestConnected: false,
        guestIdentity: { state: 'mismatch', error: { code: 'GUEST_TOOL_CONTRACT_MISMATCH' } },
      });
    } finally {
      await vm.close();
    }
  });

  it('does not let callers mutate a returned VM status to forge verified guest identity', async () => {
    const fake = new FakeHostProcess(true, undefined, { buildId: '0'.repeat(64) });
    const vm = makeController(fake);

    try {
      await expect(vm.start()).rejects.toMatchObject({ code: 'GUEST_BUILD_IDENTITY_MISMATCH' });
      const returnedStatus = await vm.status();
      const returnedIdentity = returnedStatus.guestIdentity;
      if (!returnedIdentity) throw new Error('VM status omitted guest identity diagnostics');
      returnedIdentity.state = 'verified';
      returnedIdentity.runningBuildId = returnedIdentity.expectedBuildId;
      returnedIdentity.runningBundleSha256 = returnedIdentity.expectedBundleSha256;
      returnedIdentity.runningProtocolVersion = returnedIdentity.expectedProtocolVersion;
      returnedIdentity.runningProtocolContractSha256 = returnedIdentity.expectedProtocolContractSha256;
      delete returnedIdentity.error;

      await expect(vm.guestRequest('browser.getState', {})).rejects.toMatchObject({
        code: 'GUEST_BUILD_IDENTITY_MISMATCH',
      });
    } finally {
      await vm.close();
    }
  });

  it('detects a guest process that stayed loaded after the on-disk bundle was rebuilt', async () => {
    const fake = new FakeHostProcess(true);
    const vm = makeController(fake);

    try {
      await vm.start();
      const guestDirectory = join(fake.config.runtimeDir, 'guest');
      const replacementBundle = Buffer.from('newer guest bundle');
      const replacementManifest: GuestBuildManifest = {
        ...fake.guestManifest,
        bundleSha256: sha256Hex(replacementBundle),
        bundleSizeBytes: replacementBundle.byteLength,
      };
      writeFileSync(join(guestDirectory, 'helm-guest.js'), replacementBundle);
      writeFileSync(join(guestDirectory, 'helm-guest.manifest.json'), JSON.stringify(replacementManifest));

      await expect(vm.status()).resolves.toMatchObject({
        guestConnected: false,
        guestIdentity: {
          state: 'mismatch',
          error: { code: 'GUEST_RUNNING_BUILD_STALE' },
        },
      });
      await expect(vm.guestRequest('browser.getState', {})).rejects.toMatchObject({
        code: 'GUEST_RUNNING_BUILD_STALE',
      });
      expect(fake.commands.filter(command => command === 'vm.guestRequest').length).toBe(2);
    } finally {
      await vm.close();
    }
  });

  it('keeps the native VM running when guest handshake readiness fails', async () => {
    const fake = new FakeHostProcess(false);
    const vm = makeController(fake);

    try {
      await expect(vm.start()).rejects.toMatchObject({ code: 'GUEST_NOT_READY' });
      expect(fake.nativeState).toBe('running');
      expect(fake.killed).toBe(false);
      await expect(vm.status()).resolves.toMatchObject({
        state: 'running',
        guestConnected: false,
        message: 'VM is running, but helm-guest is not ready: helm-guest is not ready',
      });
    } finally {
      await vm.close();
    }
  });

  it('handles backend SIGTERM while running by stopping gracefully before terminating the helper', async () => {
    const fake = new FakeHostProcess(true);
    const vm = makeController(fake);

    await vm.start();
    // The server's SIGINT/SIGTERM handlers call application.close(), which
    // delegates to the controller's close path.
    await vm.close();

    expect(fake.nativeState).toBe('stopped');
    expect(fake.commands).toContain('vm.stop');
    expect(fake.commands).not.toContain('vm.force-stop');
    expect(fake.killed).toBe(true);
    expect(fake.commands.indexOf('vm.stop')).toBeLessThan(fake.killCommandCount);
  });

  it('uses graceful vm:stop without an emergency hard-stop', async () => {
    const fake = new FakeHostProcess(true);
    const vm = makeController(fake);

    try {
      await vm.start();
      await vm.stop();
      expect(fake.nativeState).toBe('stopped');
      expect(fake.commands).toContain('vm.stop');
      expect(fake.commands).not.toContain('vm.force-stop');
      expect(fake.killed).toBe(true);
    } finally {
      await vm.close();
    }
  });

  it('reports the disk mutation guard when vm:reset is requested while running', async () => {
    const fake = new FakeHostProcess(true);
    const vm = makeController(fake);

    try {
      await vm.start();
      await expect(vm.reset()).rejects.toThrow(
        'VM is running. Shut it down before modifying disk images.',
      );
      await expect(vm.status()).resolves.toMatchObject({
        state: 'running',
        message: 'VM is running. Shut it down before modifying disk images.',
      });
    } finally {
      await vm.close();
    }
  });

  it('does not disconnect the guest when an individual guest operation fails', async () => {
    const fake = new FakeHostProcess(true, 'browser.click');
    const vm = makeController(fake);

    try {
      await vm.start();
      await expect(vm.guestRequest('browser.click', { x: 10, y: 10 })).rejects.toMatchObject({
        code: 'guest_operation_failed',
      });
      await expect(vm.status()).resolves.toMatchObject({
        state: 'running',
        guestConnected: true,
      });
    } finally {
      await vm.close();
    }
  });
});
