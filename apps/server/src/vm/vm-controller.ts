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

export interface VmControllerDependencies {
  helperAvailable?: boolean;
  spawn?: typeof spawn;
  guestRetryAttempts?: number;
  guestRetryDelayMs?: number;
  hostCommandTimeoutMs?: number;
  childTerminationTimeoutMs?: number;
}

const DESKTOP_SCREENSHOT_POLL_INTERVAL_MS = 1_000;
const GUEST_RECONNECT_INITIAL_DELAY_MS = 1_500;
const GUEST_RECONNECT_MAX_DELAY_MS = 10_000;
const VM_RUNNING_DISK_MUTATION_MESSAGE = 'VM is running. Shut it down before modifying disk images.';

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
  private guestReconnectTimer?: ReturnType<typeof setTimeout>;
  private guestReconnectInFlight = false;
  private guestReconnectTask?: Promise<void>;
  private guestReconnectDelayMs = GUEST_RECONNECT_INITIAL_DELAY_MS;
  private helperShowsWindow = false;
  private expectedChildExit = false;
  private closing = false;
  private readonly dependencies: Required<
    Pick<
      VmControllerDependencies,
      'guestRetryAttempts' | 'guestRetryDelayMs' | 'hostCommandTimeoutMs' | 'childTerminationTimeoutMs'
    >
  > & Pick<VmControllerDependencies, 'spawn'>;
  private currentStatus: VmStatus = {
    state: 'stopped',
    helperAvailable: false,
    guestConnected: false,
  };

  constructor(
    private readonly config: HelmConfig,
    private readonly events: EventHub,
    private readonly guestTransport?: GuestTransport,
    dependencies: VmControllerDependencies = {},
  ) {
    this.currentStatus.helperAvailable = dependencies.helperAvailable
      ?? virtualizationHelperAvailable(config.vmHelperPath);
    this.dependencies = {
      spawn: dependencies.spawn,
      guestRetryAttempts: dependencies.guestRetryAttempts ?? 20,
      guestRetryDelayMs: dependencies.guestRetryDelayMs ?? 500,
      hostCommandTimeoutMs: dependencies.hostCommandTimeoutMs ?? 30_000,
      childTerminationTimeoutMs: dependencies.childTerminationTimeoutMs ?? 30_000,
    };
  }

  async start(options: VmStartOptions = {}): Promise<void> {
    this.assertAccepting('start the VM');
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
      await this.stopInternal();
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

    let nativeVmBooted = false;
    let guestReadinessAttempted = false;
    try {
      this.ensureChild(showWindow);
      const response = await this.sendHostCommand('vm.start', {});
      const result = recordFrom(response.result);
      nativeVmBooted = normalizeVmState(result?.state, 'starting') === 'running';
      if (nativeVmBooted) {
        this.setStatus({
          state: 'running',
          guestConnected: false,
          ...(typeof result?.uncleanShutdownDetected === 'boolean'
            ? { uncleanShutdownDetected: result.uncleanShutdownDetected }
            : {}),
          message: 'VM is running; waiting for helm-guest readiness',
        });
      }
      guestReadinessAttempted = true;
      await this.connectGuestWithRetry();
      try {
        await this.guestRequest('desktop.screenshot', {});
      } catch (error) {
        // A missing screenshot utility should not make an otherwise connected
        // guest look disconnected. The next explicit screenshot can retry it.
        this.setStatus({ guestConnected: true });
        logger.warn('Initial VM screenshot unavailable', { component: 'vm', ...loggedVmError(error) });
      }
      this.setStatus({ state: 'running', guestConnected: true, message: undefined });
      this.resetGuestReconnectBackoff();
      this.events.publish('guest.connected', { connected: true });
      this.startScreenshotPolling();
    } catch (error) {
      const normalized = structuredVmError(error);
      const mayStillBeRunning = nativeVmBooted
        || ['running', 'starting', 'stopping'].includes(this.currentStatus.state);
      const vmStillRunning = mayStillBeRunning && await this.nativeVmIsRunning(mayStillBeRunning);
      if (vmStillRunning) {
        const readinessFailure = guestReadinessAttempted || normalized.code === 'GUEST_NOT_READY';
        const message = readinessFailure
          ? 'VM is running, but helm-guest is not ready: ' + normalized.message
          : 'VM is running, but native VM startup reported an error: ' + normalized.message;
        logger.warn(readinessFailure
          ? 'VM guest readiness failed; leaving the VM running'
          : 'VM native startup reported an error after boot; leaving the VM running', {
          component: 'vm',
          ...loggedVmError(error),
        });
        this.setStatus({ state: 'running', guestConnected: false, message });
        this.scheduleGuestReconnect();
        throw new VmControllerError(
          readinessFailure ? 'GUEST_NOT_READY' : 'VM_BOOT_ERROR',
          message,
          normalized.details,
        );
      }
      logger.error('VM start failed', { component: 'vm', ...loggedVmError(error) });
      this.setStatus({ state: 'error', guestConnected: false, message: normalized.message });
      throw error;
    }
  }

  async reconnect(force = false): Promise<void> {
    this.assertAccepting('reconnect to the guest');
    if (this.currentStatus.guestConnected && !force) return;
    if (!this.currentStatus.helperAvailable) {
      this.setStatus({
        state: 'unavailable',
        message: `VM helper not found at ${this.config.vmHelperPath}`,
      });
      return;
    }

    this.stopScreenshotPolling();
    let nativeVmRunning = this.currentStatus.state === 'running';
    let guestReadinessAttempted = false;
    this.setStatus({ state: nativeVmRunning ? 'running' : 'starting', message: 'Reconnecting to the Linux guest' });
    try {
      if (!this.child) {
        await this.start({ showWindow: this.helperShowsWindow });
        return;
      }

      let hostState = this.currentStatus.state;
      try {
        const response = await this.sendHostCommand('vm.status', {});
        const result = recordFrom(response.result);
        hostState = normalizeVmState(result?.state, hostState);
        nativeVmRunning = hostState === 'running';
        if (typeof result?.uncleanShutdownDetected === 'boolean') {
          this.setStatus({ uncleanShutdownDetected: result.uncleanShutdownDetected });
        }
      } catch {
        // If status cannot be read, vm.start below gives the helper a chance to
        // restore a stopped VM. A running VM can still be reached directly.
      }
      if (hostState !== 'running') {
        const response = await this.sendHostCommand('vm.start', {});
        const result = recordFrom(response.result);
        hostState = normalizeVmState(result?.state, hostState);
        nativeVmRunning = hostState === 'running';
        if (typeof result?.uncleanShutdownDetected === 'boolean') {
          this.setStatus({ uncleanShutdownDetected: result.uncleanShutdownDetected });
        }
      }

      guestReadinessAttempted = true;
      await this.connectGuestWithRetry();
      try {
        await this.guestRequest('desktop.screenshot', {});
      } catch (error) {
        this.setStatus({ guestConnected: true });
        logger.warn('Initial VM screenshot unavailable after reconnect', {
          component: 'vm',
          ...loggedVmError(error),
        });
      }
      this.setStatus({ state: 'running', guestConnected: true, message: undefined });
      this.resetGuestReconnectBackoff();
      this.events.publish('guest.connected', { connected: true });
      this.startScreenshotPolling();
    } catch (error) {
      const normalized = structuredVmError(error);
      const mayStillBeRunning = nativeVmRunning
        || ['running', 'starting', 'stopping'].includes(this.currentStatus.state);
      const vmStillRunning = mayStillBeRunning && await this.nativeVmIsRunning(mayStillBeRunning);
      if (vmStillRunning) {
        const readinessFailure = guestReadinessAttempted || normalized.code === 'GUEST_NOT_READY';
        const message = readinessFailure
          ? 'VM is running, but helm-guest is not ready: ' + normalized.message
          : 'VM is running, but native VM startup reported an error: ' + normalized.message;
        logger.warn(readinessFailure
          ? 'VM guest readiness failed during reconnect; leaving the VM running'
          : 'VM native startup reported an error after boot during reconnect; leaving the VM running', {
          component: 'vm',
          ...loggedVmError(error),
        });
        this.setStatus({ state: 'running', guestConnected: false, message });
        this.scheduleGuestReconnect();
        throw new VmControllerError(
          readinessFailure ? 'GUEST_NOT_READY' : 'VM_BOOT_ERROR',
          message,
          normalized.details,
        );
      }
      logger.error('VM reconnect failed', { component: 'vm', ...loggedVmError(error) });
      this.setStatus({ state: 'error', guestConnected: false, message: normalized.message });
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.assertAccepting('stop the VM');
    await this.stopInternal();
  }

  async forceStop(): Promise<void> {
    this.assertAccepting('force-stop the VM');
    await this.forceStopInternal();
  }

  private async stopInternal(): Promise<void> {
    this.cancelGuestReconnect();
    await this.waitForGuestReconnect();
    this.stopScreenshotPolling();
    if (!this.child && !['stopped', 'unavailable'].includes(this.currentStatus.state)) {
      throw new VmControllerError(
        'VM_HELPER_NOT_RUNNING',
        'VM helper is not running; the VM state cannot be confirmed stopped.',
      );
    }
    if (this.child) {
      try {
        await this.sendHostCommand('vm.stop', {});
      } catch (error) {
        const normalized = structuredVmError(error);
        logger.error('Graceful VM stop command failed', { component: 'vm', ...loggedVmError(error) });
        this.setStatus({
          state: this.currentStatus.state === 'running' ? 'running' : 'error',
          guestConnected: false,
          message: normalized.message,
        });
        throw error;
      }
    }
    await this.guestTransport?.close();
    this.setStatus({ state: 'stopped', guestConnected: false, screenshot: undefined, message: undefined });
    this.events.publish('guest.disconnected', { connected: false });
    // Release the native VM object and its disk attachment. A stopped helper
    // is still an owner of the VM working image until it exits.
    await this.terminateChild();
  }

  private async forceStopInternal(): Promise<void> {
    this.cancelGuestReconnect();
    await this.waitForGuestReconnect();
    this.stopScreenshotPolling();
    if (!this.child && !['stopped', 'unavailable'].includes(this.currentStatus.state)) {
      throw new VmControllerError(
        'VM_HELPER_NOT_RUNNING',
        'VM helper is not running; emergency VM state cannot be confirmed.',
      );
    }
    if (this.child) {
      try {
        await this.sendHostCommand('vm.force-stop', {});
      } catch (error) {
        const normalized = structuredVmError(error);
        logger.error('Emergency VM stop command failed', { component: 'vm', ...loggedVmError(error) });
        this.setStatus({ state: 'error', guestConnected: false, message: normalized.message });
        throw error;
      }
    }
    await this.guestTransport?.close();
    this.setStatus({ state: 'stopped', guestConnected: false, screenshot: undefined, message: undefined });
    this.events.publish('guest.disconnected', { connected: false });
    await this.terminateChild();
  }

  async reset(): Promise<void> {
    this.assertAccepting('reset the VM');
    this.cancelGuestReconnect();
    await this.waitForGuestReconnect();
    this.stopScreenshotPolling();
    if (this.currentStatus.state === 'running'
      || this.currentStatus.state === 'starting'
      || this.currentStatus.state === 'stopping') {
      this.setStatus({ guestConnected: false, message: VM_RUNNING_DISK_MUTATION_MESSAGE });
      throw new VmControllerError('VM_RUNNING', VM_RUNNING_DISK_MUTATION_MESSAGE);
    }
    if (!this.currentStatus.helperAvailable) {
      this.setStatus({ state: 'unavailable', message: `VM helper not found at ${this.config.vmHelperPath}` });
      return;
    }
    this.setStatus({ state: this.currentStatus.state, message: 'Resetting the working VM disk' });
    try {
      this.ensureChild();
      await this.sendHostCommand('vm.reset', {});
    } catch (error) {
      const normalized = structuredVmError(error);
      const observedState = this.currentStatus.state as VmStatus['state'];
      this.setStatus({
        state: observedState === 'running' ? 'running' : 'error',
        guestConnected: false,
        message: normalized.message,
      });
      throw error;
    }
    await this.guestTransport?.close();
    this.setStatus({ state: 'stopped', guestConnected: false, screenshot: undefined, message: undefined });
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
            ...(typeof result.message === 'string' ? { message: result.message } : {}),
            ...(typeof result.uncleanShutdownDetected === 'boolean'
              ? { uncleanShutdownDetected: result.uncleanShutdownDetected }
              : {}),
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
    this.assertAccepting('use the guest');
    const request: GuestRequest = { id: `guest_${Date.now()}_${Math.random().toString(36).slice(2)}`, method, params };
    if (this.child) {
      try {
        const response = await abortable(this.sendHostCommand('vm.guestRequest', request), signal);
        const parsed = guestResponseSchema.safeParse(response.result);
        if (!parsed.success) {
          throw new VmControllerError(
            'INVALID_GUEST_RESPONSE',
            'The guest returned an invalid response',
            parsed.error.issues,
            true,
          );
        }
        if (!parsed.data.ok) {
          throw new VmControllerError(
            parsed.data.error?.code ?? 'GUEST_REQUEST_FAILED',
            parsed.data.error?.message ?? 'The guest rejected the request',
            parsed.data.error?.details,
            false,
          );
        }
        const result = parsed.data.result as T;
        if (behavior.publishScreenshot !== false) {
          this.publishScreenshot(result);
        }
        return result;
      } catch (error) {
        if (error instanceof VmControllerError) {
          if (error.connectionLost) {
            if (behavior.preserveConnectionOnError) this.scheduleGuestReconnect(true);
            else this.markGuestConnectionLost(error);
          }
          throw error;
        }
        const normalized = asToolError(error);
        const connectionError = new VmControllerError(normalized.code, normalized.message, normalized.details, true);
        if (behavior.preserveConnectionOnError) this.scheduleGuestReconnect(true);
        else this.markGuestConnectionLost(connectionError);
        throw connectionError;
      }
    }
    if (!this.guestTransport?.connected) {
      const connectionError = new VmControllerError('GUEST_NOT_CONNECTED', 'The Linux guest is not connected', undefined, true);
      if (behavior.preserveConnectionOnError) this.scheduleGuestReconnect(true);
      else this.markGuestConnectionLost(connectionError);
      throw connectionError;
    }
    try {
      const result = await this.guestTransport.request<T>(request, signal);
      if (behavior.publishScreenshot !== false) {
        this.publishScreenshot(result);
      }
      return result;
    } catch (error) {
      const normalized = asToolError(error);
      const connectionLost = typeof error === 'object'
        && error !== null
        && 'connectionLost' in error
        && (error as { connectionLost?: unknown }).connectionLost === true;
      const connectionError = new VmControllerError(
        normalized.code,
        normalized.message,
        normalized.details,
        connectionLost,
      );
      if (connectionLost) {
        if (behavior.preserveConnectionOnError) this.scheduleGuestReconnect(true);
        else this.markGuestConnectionLost(connectionError);
      }
      throw connectionError;
    }
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    this.cancelGuestReconnect();
    this.stopScreenshotPolling();
    this.rejectPendingHostRequests(new Error('VM controller is shutting down'));
    try {
      await this.stopInternal();
    } catch (error) {
      logger.error('Graceful VM shutdown failed; trying emergency VM stop', {
        component: 'vm',
        ...loggedVmError(error),
      });
      try {
        await this.forceStopInternal();
      } catch (forceError) {
        logger.error('Emergency VM stop failed; helper termination is now the last resort', {
          component: 'vm',
          ...loggedVmError(forceError),
        });
      }
    }
    this.rejectPendingHostRequests(new Error('VM controller closed'));
    await this.guestTransport?.close();
    this.setStatus({ guestConnected: false });
    await this.terminateChild();
  }

  private rejectPendingHostRequests(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private assertAccepting(operation: string): void {
    if (this.closing) {
      throw new VmControllerError(
        'VM_CONTROLLER_CLOSING',
        'The VM controller is shutting down; it cannot ' + operation + '.',
      );
    }
  }

  private setStatus(update: Partial<VmStatus>): void {
    this.currentStatus = { ...this.currentStatus, ...update };
    this.events.publish('vm.status', {
      state: this.currentStatus.state,
      helperAvailable: this.currentStatus.helperAvailable,
      guestConnected: this.currentStatus.guestConnected,
      ...(this.currentStatus.uncleanShutdownDetected === undefined
        ? {}
        : { uncleanShutdownDetected: this.currentStatus.uncleanShutdownDetected }),
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
  }

  private stopScreenshotPolling(): void {
    this.screenshotPollingEnabled = false;
    if (this.screenshotPollTimer !== undefined) {
      clearInterval(this.screenshotPollTimer);
      this.screenshotPollTimer = undefined;
    }
  }

  private markGuestConnectionLost(error: VmControllerError): void {
    const message = `Linux guest connection lost: ${error.message}`;
    this.setStatus({ guestConnected: false, message });
    this.events.publish('guest.disconnected', { connected: false });
    this.scheduleGuestReconnect();
  }

  private scheduleGuestReconnect(force = false): void {
    if (this.closing
      || !this.child
      || this.currentStatus.state !== 'running'
      || (this.currentStatus.guestConnected && !force)
      || this.guestReconnectTimer !== undefined
      || this.guestReconnectInFlight) {
      return;
    }
    const delay = this.guestReconnectDelayMs;
    this.guestReconnectTimer = setTimeout(() => {
      this.guestReconnectTimer = undefined;
      if (this.closing || !this.child || this.currentStatus.state !== 'running') return;
      this.guestReconnectInFlight = true;
      const reconnectTask = this.reconnect(force)
        .then(() => {
          this.resetGuestReconnectBackoff();
        })
        .catch(error => {
          logger.warn('Automatic guest reconnect failed; keeping the VM running and retrying', {
            component: 'vm',
            ...loggedVmError(error),
          });
          this.guestReconnectDelayMs = Math.min(
            this.guestReconnectDelayMs * 2,
            GUEST_RECONNECT_MAX_DELAY_MS,
          );
          return undefined;
        });
      this.guestReconnectTask = reconnectTask;
      void reconnectTask.finally(() => {
        this.guestReconnectInFlight = false;
        if (this.guestReconnectTask === reconnectTask) this.guestReconnectTask = undefined;
        this.scheduleGuestReconnect();
      });
    }, delay);
  }

  private cancelGuestReconnect(): void {
    if (this.guestReconnectTimer !== undefined) {
      clearTimeout(this.guestReconnectTimer);
      this.guestReconnectTimer = undefined;
    }
  }

  private async waitForGuestReconnect(): Promise<void> {
    const reconnectTask = this.guestReconnectTask;
    if (reconnectTask) await reconnectTask.catch(() => undefined);
  }

  private resetGuestReconnectBackoff(): void {
    this.guestReconnectDelayMs = GUEST_RECONNECT_INITIAL_DELAY_MS;
    this.cancelGuestReconnect();
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

  private async nativeVmIsRunning(fallback = this.currentStatus.state === 'running'): Promise<boolean> {
    if (!this.child) return false;
    try {
      const response = await this.sendHostCommand('vm.status', {});
      const result = recordFrom(response.result);
      return normalizeVmState(result?.state, 'error') === 'running';
    } catch {
      // Retain the safe assumption that the VM may still be running when the
      // helper cannot answer a status query. The caller must never power it
      // off merely because readiness/status I/O failed.
      return fallback;
    }
  }

  private ensureChild(showWindow = false): void {
    if (this.child) return;
    if (!this.currentStatus.helperAvailable) {
      throw new VmControllerError('VM_HELPER_MISSING', `VM helper not found at ${this.config.vmHelperPath}`);
    }
    const helperArguments = [
      '--root', this.config.dataDir,
      '--base-image', this.config.baseImagePath,
      '--working-image', this.config.workingImagePath,
      '--efi-vars', this.config.efiVariablesPath,
      '--machine-id', this.config.machineIdentifierPath,
      '--runtime-share', this.config.runtimeDir,
      '--runtime-tag', this.config.runtimeTag,
      '--guest-port', String(this.config.guestPort),
      '--memory-mib', String(this.config.vmMemoryMb),
      '--cpus', String(this.config.vmCpus),
      ...(showWindow ? ['--show-window'] : []),
    ];
    const child = (this.dependencies.spawn ?? spawn)(
      this.config.vmHelperPath,
      helperArguments,
      { stdio: 'pipe' },
    );
    this.child = child;
    this.expectedChildExit = false;
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
      const expected = this.expectedChildExit;
      this.expectedChildExit = false;
      const stateWasKnownStopped = this.currentStatus.state === 'stopped'
        || this.currentStatus.state === 'unavailable';
      if (expected || stateWasKnownStopped) {
        this.setStatus({ state: 'stopped', guestConnected: false });
      } else {
        this.setStatus({
          state: 'error',
          guestConnected: false,
          message: 'helm-vm-host exited unexpectedly; VM state is unknown.',
        });
      }
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
    this.expectedChildExit = true;
    this.helperShowsWindow = false;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const exited = await this.waitForChildExit(child, this.dependencies.childTerminationTimeoutMs);
      if (!exited) {
        logger.error('Forced VM host termination required after graceful shutdown attempts were exhausted', {
          component: 'vm-host',
        });
        child.kill('SIGKILL');
        await this.waitForChildExit(child, 2_000);
      }
    }
    if (this.child === child && (child.exitCode !== null || child.signalCode !== null)) {
      this.child = undefined;
    }
  }

  private waitForChildExit(
    child: ChildProcessWithoutNullStreams,
    timeoutMilliseconds: number,
  ): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        resolve(false);
      }, timeoutMilliseconds);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve(true);
      });
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
    if (!this.child?.stdin.writable) {
      throw new VmControllerError('VM_HELPER_NOT_RUNNING', 'VM helper is not running', undefined, true);
    }
    const id = `host_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    return new Promise<HostResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VmControllerError('VM_HELPER_TIMEOUT', `VM helper timed out handling ${method}`, undefined, true));
      }, this.dependencies.hostCommandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child?.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    }).then(response => {
      if (!response.ok) {
        const nativeError = response.error;
        throw new VmControllerError(
          nativeError?.code ?? 'VM_HELPER_ERROR',
          nativeError?.message ?? 'VM helper rejected the request',
          nativeError?.details,
          true,
        );
      }
      return response;
    });
  }

  private async connectGuestWithRetry(): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.dependencies.guestRetryAttempts; attempt += 1) {
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
        await new Promise(resolve => setTimeout(resolve, this.dependencies.guestRetryDelayMs));
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
    public readonly connectionLost = false,
  ) {
    super(message);
    this.name = 'VmControllerError';
  }
}
