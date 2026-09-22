import type { GuestRequest, ToolError } from '@helm/shared';

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

export function asToolError(error: unknown): ToolError {
  if (error instanceof GuestTransportError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  if (error instanceof Error) return { code: 'GUEST_REQUEST_FAILED', message: error.message };
  return { code: 'GUEST_REQUEST_FAILED', message: String(error) };
}
