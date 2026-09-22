import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { guestResponseSchema } from '@helm/shared';
import type { GuestMethod, GuestRequest, ToolError, VmStatus } from '@helm/shared';
import type { HelmConfig } from '../config';
import { EventHub } from '../events';
import { logger } from '../logger';
import { virtualizationHelperAvailable } from './helper';
import { asToolError, type GuestTransport } from './transport';

interface HostResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: ToolError;
}

interface PendingHostRequest {
  resolve: (response: HostResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface GuestRequestBehavior {
  preserveConnectionOnError?: boolean;
  publishScreenshot?: boolean;
}

export interface VmStartOptions {
  showWindow?: boolean;
}

const DESKTOP_SCREENSHOT_POLL_INTERVAL_MS = 750;

function normalizeVmState(value: unknown, fallback: VmStatus['state']): VmStatus['state'] {
  switch (value) {
    case 'stopped':
    case 'starting':
    case 'running':
    case 'stopping':
    case 'error':
    case 'unavailable':
      return value;
    case 'paused':
    case 'pausing':
    case 'resuming':
    case 'restoring':
    case 'saving':
      return 'running';
    default:
      return fallback;
  }
}

function recordFrom(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function screenshotImage(value: unknown): string | undefined {
  const record = recordFrom(value);
  const candidate = record?.image ?? record?.screenshot ?? record?.base64;
  if (typeof candidate !== 'string' || candidate.length === 0) return undefined;
  return candidate.startsWith('data:') ? candidate : `data:image/png;base64,${candidate}`;
}

function structuredVmError(error: unknown): ToolError {
  if (error instanceof VmControllerError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return asToolError(error);
}

function loggedVmError(error: unknown): { error: unknown; code: string; details?: unknown } {
  const normalized = structuredVmError(error);
  return {
    error,
    code: normalized.code,
    ...(normalized.details === undefined ? {} : { details: normalized.details }),
  };
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new VmControllerError('CANCELLED', 'The guest request was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new VmControllerError('CANCELLED', 'The guest request was cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export class VmController {
  private child?: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private readonly pending = new Map<string, PendingHostRequest>();
  private screenshotPollTimer?: ReturnType<typeof setInterval>;
  private screenshotPollInFlight = false;
  private screenshotPollingEnabled = false;
  private helperShowsWindow = false;
  private currentStatus: VmStatus = {
    state: 'stopped',
    helperAvailable: false,
    guestConnected: false,
  };

  constructor(
    private readonly config: HelmConfig,
    private readonly events: EventHub,
    private readonly guestTransport?: GuestTransport,
  ) {
    this.currentStatus.helperAvailable = virtualizationHelperAvailable(config.vmHelperPath);
  }

  async start(options: VmStartOptions = {}): Promise<void> {
    const showWindow = options.showWindow === true;
    if (this.currentStatus.state === 'running' && this.currentStatus.guestConnected) {
      if (!showWindow || this.helperShowsWindow) return;
      throw new VmControllerError(
        'VM_HELPER_MODE_MISMATCH',
        'The VM is already running headlessly. Stop it before restarting with --gui.',
      );
    }
    if (showWindow && this.child && !this.helperShowsWindow) {
      if (this.currentStatus.state === 'running' || this.currentStatus.state === 'starting') {
        throw new VmControllerError(
          'VM_HELPER_MODE_MISMATCH',
          'The VM helper is already running headlessly. Stop the VM before starting with --gui.',
        );
      }
      await this.terminateChild();
    }
    this.setStatus({ state: 'starting', message: 'Starting the VM helper' });
    if (!this.currentStatus.helperAvailable) {
      this.setStatus({
        state: 'unavailable',
        message: `VM helper not found at ${this.config.vmHelperPath}`,
      });
      return;
    }

    try {
      this.ensureChild(showWindow);
      await this.sendHostCommand('vm.start', {});
      await this.connectGuestWithRetry();
      try {
        await this.guestRequest('desktop.screenshot', {});
      } catch (error) {
        // A missing screenshot utility should not make an otherwise connected
        // guest look disconnected. The next explicit screenshot can retry it.
        this.setStatus({ guestConnected: true });
        logger.warn('Initial VM screenshot unavailable', { component: 'vm', ...loggedVmError(error) });
      }
      this.setStatus({ state: 'running', guestConnected: true });
      this.events.publish('guest.connected', { connected: true });
      this.startScreenshotPolling();
    } catch (error) {
      const normalized = structuredVmError(error);
      logger.error('VM start failed', { component: 'vm', ...loggedVmError(error) });
      this.setStatus({ state: 'error', message: normalized.message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopScreenshotPolling();
    if (this.child) {
      try {
        await this.sendHostCommand('vm.stop', {});
      } catch (error) {
        logger.warn('VM stop command failed', { component: 'vm', ...loggedVmError(error) });
      }
    }
    await this.guestTransport?.close();
    this.setStatus({ state: 'stopped', guestConnected: false, screenshot: undefined });
    this.events.publish('guest.disconnected', { connected: false });
  }

  async reset(): Promise<void> {
    this.stopScreenshotPolling();
    if (!this.currentStatus.helperAvailable) {
      this.setStatus({ state: 'unavailable', message: `VM helper not found at ${this.config.vmHelperPath}` });
      return;
    }
    this.setStatus({ state: 'stopping', message: 'Resetting the working VM disk' });
    this.ensureChild();
    await this.sendHostCommand('vm.reset', {});
    await this.guestTransport?.close();
    this.setStatus({ state: 'stopped', guestConnected: false, screenshot: undefined });
  }

  async status(): Promise<VmStatus> {
    if (this.child && this.currentStatus.helperAvailable) {
      try {
        const response = await this.sendHostCommand('vm.status', {});
        if (response.result && typeof response.result === 'object') {
          const result = response.result as Partial<VmStatus>;
          this.setStatus({
            state: normalizeVmState(result.state, this.currentStatus.state),
            guestConnected: this.currentStatus.guestConnected,
            message: result.message,
          });
        }
      } catch {
        // The cached status retains the last known state when the helper is unavailable.
      }
    }
    return { ...this.currentStatus };
  }

  async guestRequest<T>(
    method: GuestMethod,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    behavior: GuestRequestBehavior = {},
  ): Promise<T> {
    const request: GuestRequest = { id: `guest_${Date.now()}_${Math.random().toString(36).slice(2)}`, method, params };
    if (this.child) {
      try {
        const response = await abortable(this.sendHostCommand('vm.guestRequest', request), signal);
        const parsed = guestResponseSchema.safeParse(response.result);
        if (!parsed.success) {
          throw new VmControllerError('INVALID_GUEST_RESPONSE', 'The guest returned an invalid response', parsed.error.issues);
        }
        if (!parsed.data.ok) {
          throw new VmControllerError(
            parsed.data.error?.code ?? 'GUEST_REQUEST_FAILED',
            parsed.data.error?.message ?? 'The guest rejected the request',
            parsed.data.error?.details,
          );
        }
        const result = parsed.data.result as T;
        if (behavior.publishScreenshot !== false) {
          this.publishScreenshot(result);
        }
        return result;
      } catch (error) {
        if (error instanceof VmControllerError) {
          if (!behavior.preserveConnectionOnError) {
            this.setStatus({ guestConnected: false });
          }
          throw error;
        }
        const normalized = asToolError(error);
        if (!behavior.preserveConnectionOnError) {
          this.setStatus({ guestConnected: false });
        }
        throw new VmControllerError(normalized.code, normalized.message, normalized.details);
      }
    }
    if (!this.guestTransport?.connected) {
      throw new VmControllerError('GUEST_NOT_CONNECTED', 'The Linux guest is not connected');
    }
    try {
      const result = await this.guestTransport.request<T>(request, signal);
      if (behavior.publishScreenshot !== false) {
        this.publishScreenshot(result);
      }
      return result;
    } catch (error) {
      if (!behavior.preserveConnectionOnError) {
        this.setStatus({ guestConnected: false });
      }
      const normalized = asToolError(error);
      throw new VmControllerError(normalized.code, normalized.message, normalized.details);
    }
  }

  async close(): Promise<void> {
    this.stopScreenshotPolling();
    await this.stop();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('VM controller closed'));
    }
    this.pending.clear();
    await this.terminateChild();
  }

  private setStatus(update: Partial<VmStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...update };
    this.events.publish('vm.status', {
      state: this.currentStatus.state,
      helperAvailable: this.currentStatus.helperAvailable,
      guestConnected: this.currentStatus.guestConnected,
      ...(this.currentStatus.screenshot ? { screenshot: this.currentStatus.screenshot } : {}),
      ...(this.currentStatus.message ? { message: this.currentStatus.message } : {}),
    });
  }

  private publishScreenshot(result: unknown): void {
    const image = screenshotImage(result);
    if (!image) return;
    const screenshotId = recordFrom(result)?.screenshotId;
    this.setStatus({ screenshot: image });
    this.events.publish('desktop.screenshot', {
      image,
      ...(typeof screenshotId === 'string' ? { screenshotId } : {}),
    });
  }

  private startScreenshotPolling(): void {
    this.stopScreenshotPolling();
    this.screenshotPollingEnabled = true;
    this.screenshotPollTimer = setInterval(() => {
      void this.captureDesktopScreenshot();
    }, DESKTOP_SCREENSHOT_POLL_INTERVAL_MS);
    void this.captureDesktopScreenshot();
  }

  private stopScreenshotPolling(): void {
    this.screenshotPollingEnabled = false;
    if (this.screenshotPollTimer !== undefined) {
      clearInterval(this.screenshotPollTimer);
      this.screenshotPollTimer = undefined;
    }
  }

  private async captureDesktopScreenshot(): Promise<void> {
    if (!this.screenshotPollingEnabled || this.screenshotPollInFlight || !this.currentStatus.guestConnected) return;
    this.screenshotPollInFlight = true;
    try {
      const result = await this.guestRequest('desktop.screenshot', {}, undefined, {
        preserveConnectionOnError: true,
        publishScreenshot: false,
      });
      if (this.screenshotPollingEnabled) {
        this.publishScreenshot(result);
      }
    } catch (error) {
      // Screenshot capture is a best-effort UI stream. A missing helper or a
      // transient capture failure must not make a healthy guest look offline.
      logger.debug('Desktop screenshot poll failed', {
        component: 'vm',
        ...loggedVmError(error),
      });
    } finally {
      this.screenshotPollInFlight = false;
    }
  }

  private ensureChild(showWindow = false): void {
    if (this.child) return;
    if (!this.currentStatus.helperAvailable) {
      throw new VmControllerError('VM_HELPER_MISSING', `VM helper not found at ${this.config.vmHelperPath}`);
    }
    const helperArguments = [
      '--base-image', this.config.baseImagePath,
      '--working-image', this.config.workingImagePath,
      '--efi-vars', this.config.efiVariablesPath,
      '--runtime-share', this.config.runtimeDir,
      '--memory-mib', String(this.config.vmMemoryMb),
      '--cpus', String(this.config.vmCpus),
      ...(showWindow ? ['--show-window'] : []),
    ];
    const child = spawn(this.config.vmHelperPath, helperArguments, { stdio: 'pipe' });
    this.child = child;
    this.helperShowsWindow = showWindow;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    this.stderrBuffer = '';
    child.stdout.on('data', (chunk: string) => this.consumeHostOutput(chunk));
    child.stderr.on('data', (chunk: string) => this.consumeHostStderr(chunk));
    child.stderr.on('end', () => this.flushHostStderr());
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      logger.info('VM helper exited', { component: 'vm-host', code, signal });
      this.child = undefined;
      this.helperShowsWindow = false;
      this.stopScreenshotPolling();
      this.setStatus({ state: 'stopped', guestConnected: false });
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('VM helper exited'));
      }
      this.pending.clear();
    });
  }

  private async terminateChild(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = undefined;
    this.helperShowsWindow = false;
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>(resolve => {
      const timeout = setTimeout(resolve, 1_000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
      child.kill();
    });
  }

  private consumeHostOutput(chunk: string): void {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split('\n');
    this.stdoutBuffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let response: HostResponse;
      try {
        response = JSON.parse(line) as HostResponse;
      } catch {
        logger.warn('Ignoring malformed VM helper output', { component: 'vm-host' });
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      this.pending.delete(response.id);
      clearTimeout(pending.timer);
      pending.resolve(response);
    }
  }

  private consumeHostStderr(chunk: string): void {
    this.stderrBuffer += chunk;
    const lines = this.stderrBuffer.split(/\r\n|\n|\r/u);
    this.stderrBuffer = lines.pop() ?? '';
    for (const line of lines) {
      this.logHostStderrLine(line);
    }
  }

  private flushHostStderr(): void {
    if (this.stderrBuffer.length > 0) {
      this.logHostStderrLine(this.stderrBuffer);
    }
    this.stderrBuffer = '';
  }

  private logHostStderrLine(line: string): void {
    const message = line.trim();
    if (!message) return;
    logger.info(message, { component: 'vm-host' });
  }

  private sendHostCommand(method: string, params: unknown): Promise<HostResponse> {
    if (!this.child?.stdin.writable) throw new VmControllerError('VM_HELPER_NOT_RUNNING', 'VM helper is not running');
    const id = `host_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VmControllerError('VM_HELPER_TIMEOUT', `VM helper timed out handling ${method}`));
      }, 30_000);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }).then(response => {
      if (!response.ok) {
        const nativeError = response.error;
        throw new VmControllerError(
          nativeError?.code ?? 'VM_HELPER_ERROR',
          nativeError?.message ?? 'VM helper rejected the request',
          nativeError?.details,
        );
      }
      return response;
    });
  }

  private async connectGuestWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        if (this.child) {
          await this.guestRequest('guest.handshake', {});
        } else if (this.guestTransport) {
          await this.guestTransport.connect();
        } else {
          throw new VmControllerError('GUEST_TRANSPORT_MISSING', 'No guest transport is configured');
        }
        this.setStatus({ guestConnected: true });
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Guest did not become ready');
  }
}

export class VmControllerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'VmControllerError';
  }
}
