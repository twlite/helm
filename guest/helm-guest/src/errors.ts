export type RpcRequestId = string | number | null;

export interface RpcErrorPayload {
  code: string;
  message: string;
  details?: unknown;
}

/** Errors that are safe to expose through the guest protocol. */
export class GuestRpcError extends Error {
  readonly code: string;
  readonly details: unknown;
  readonly httpStatus: number;

  constructor(
    code: string,
    message: string,
    options: { details?: unknown; httpStatus?: number } = {},
  ) {
    super(message);
    this.name = "GuestRpcError";
    this.code = code;
    this.details = options.details;
    this.httpStatus = options.httpStatus ?? 200;
  }
}

export function guestError(
  code: string,
  message: string,
  details?: unknown,
  httpStatus?: number,
): GuestRpcError {
  return new GuestRpcError(code, message, {
    ...(details === undefined ? {} : { details }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
  });
}

export function asGuestRpcError(error: unknown): GuestRpcError {
  if (error instanceof GuestRpcError) {
    return error;
  }

  if (error instanceof Error) {
    return new GuestRpcError("INTERNAL_ERROR", error.message, {
      httpStatus: 500,
    });
  }

  return new GuestRpcError("INTERNAL_ERROR", "The guest operation failed.", {
    httpStatus: 500,
  });
}

export function errorPayload(error: unknown): RpcErrorPayload {
  const normalized = asGuestRpcError(error);
  const payload: RpcErrorPayload = {
    code: normalized.code,
    message: normalized.message,
  };

  if (normalized.details !== undefined) {
    payload.details = normalized.details;
  }

  return payload;
}
