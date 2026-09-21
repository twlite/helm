import type { GuestRequest, GuestResponse, ToolError } from '@helm/shared';
import { guestResponseSchema } from '@helm/shared';

export interface GuestTransport {
  connect(): Promise<void>;
  request<T>(request: GuestRequest, signal?: AbortSignal): Promise<T>;
  close(): Promise<void>;
  readonly connected: boolean;
}

export class GuestTransportError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GuestTransportError';
  }
}

export interface HttpGuestTransportOptions {
  baseUrl: string;
  timeoutMs: number;
}

export class HttpGuestTransport implements GuestTransport {
  private _connected = false;

  constructor(private readonly options: HttpGuestTransportOptions) {}

  get connected(): boolean {
    return this._connected;
  }

  async connect(): Promise<void> {
    await this.requestRaw({ id: `handshake_${Date.now()}`, method: 'guest.handshake', params: {} });
    this._connected = true;
  }

  async request<T>(request: GuestRequest, signal?: AbortSignal): Promise<T> {
    const response = await this.requestRaw(request, signal);
    if (!response.ok) {
      throw new GuestTransportError(
        response.error?.code ?? 'GUEST_REQUEST_FAILED',
        response.error?.message ?? 'The guest rejected the request',
        response.error?.details,
      );
    }
    return response.result as T;
  }

  async close(): Promise<void> {
    this._connected = false;
  }

  private async requestRaw(request: GuestRequest, signal?: AbortSignal): Promise<GuestResponse> {
    const timeout = AbortSignal.timeout(this.options.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await fetch(`${this.options.baseUrl}/rpc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: combined,
      });
    } catch (error) {
      this._connected = false;
      throw new GuestTransportError('GUEST_UNAVAILABLE', 'Could not reach helm-guest', error);
    }
    const body: unknown = await response.json().catch(() => undefined);
    const parsed = guestResponseSchema.safeParse(body);
    if (!parsed.success) {
      this._connected = false;
      throw new GuestTransportError('INVALID_GUEST_RESPONSE', 'The guest returned an invalid response', parsed.error.issues);
    }
    if (!response.ok) {
      this._connected = false;
    }
    return parsed.data;
  }
}

export function asToolError(error: unknown): ToolError {
  if (error instanceof GuestTransportError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) return { code: 'GUEST_REQUEST_FAILED', message: error.message };
  return { code: 'GUEST_REQUEST_FAILED', message: String(error) };
}
