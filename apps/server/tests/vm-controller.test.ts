import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'bun:test';

import { loadConfig } from '../src/config';
import { EventHub } from '../src/events';
import {
  VmController,
  type VmControllerDependencies,
} from '../src/vm/vm-controller';

type HostRequest = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
};

class FakeHostProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: string[] = [];
  nativeState: 'stopped' | 'running' = 'stopped';
  killed = false;
  killCommandCount = -1;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  private inputBuffer = '';

  constructor(
    private readonly handshakeReady: boolean,
    private readonly failedGuestMethod?: string,
  ) {
    super();
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
        this.respond(request.id, true, {
          id: guestId,
          ok: true,
          result: guestRequest?.method === 'desktop.screenshot'
            ? {}
            : { runtime: 'helm-guest', protocolVersion: 1 },
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
  const dataDir = join(tmpdir(), 'helm-vm-controller-' + randomUUID());
  const config = loadConfig({
    HELM_DATA_DIR: dataDir,
    HELM_VM_HELPER: join(dataDir, 'fake-helm-vm-host'),
  });
  const spawnHost = (() => fake) as NonNullable<VmControllerDependencies['spawn']>;
  return new VmController(
    config,
    new EventHub(),
    undefined,
    {
      helperAvailable: true,
      spawn: spawnHost,
      guestRetryAttempts: 1,
      guestRetryDelayMs: 0,
      hostCommandTimeoutMs: 1_000,
      childTerminationTimeoutMs: 1_000,
    },
  );
}

describe('VM lifecycle safety', () => {
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
