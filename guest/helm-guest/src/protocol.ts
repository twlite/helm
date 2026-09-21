import { GuestRpcError, type RpcErrorPayload, type RpcRequestId } from "./errors";
import {
  guestMethodSchemas,
  guestRequestEnvelopeSchema,
  guestResponseSchema,
  type GuestMethod as SharedGuestMethod,
} from "../../../packages/shared/src/index";

/*
 * The full workspace owns the canonical Zod declarations for this protocol in
 * @helm/shared. The guest is also built and copied as a standalone artifact,
 * so this file intentionally contains a small structural decoder as its
 * bundle-safe boundary. Its wire shape matches GuestRequest/GuestResponse and
 * the method contracts used by the shared package.
 */

export const GUEST_METHODS = Object.keys(guestMethodSchemas) as SharedGuestMethod[];

export type GuestMethod = SharedGuestMethod;
export type GuestRequestId = Exclude<RpcRequestId, null>;

export interface GuestRequest {
  id: GuestRequestId;
  method: GuestMethod;
  params: unknown;
}

export interface GuestSuccessResponse<T = unknown> {
  id: RpcRequestId;
  ok: true;
  result: T;
}

export interface GuestFailureResponse {
  id: RpcRequestId;
  ok: false;
  error: RpcErrorPayload;
}

export type GuestResponse<T = unknown> =
  | GuestSuccessResponse<T>
  | GuestFailureResponse;

export const GuestMethodContracts: Readonly<
  Record<GuestMethod, { description: string }>
> = {
  "guest.handshake": { description: "Report guest runtime readiness and methods." },
  "fs.read": { description: "Read UTF-8 text from the guest sandbox." },
  "fs.write": { description: "Write UTF-8 text inside the guest sandbox." },
  "fs.exists": { description: "Check whether a sandbox path exists." },
  "fs.list": { description: "List entries in a sandbox directory." },
  "fs.stat": { description: "Inspect a sandbox path." },
  "browser.navigate": { description: "Navigate the visible Chromium page." },
  "browser.getState": { description: "Read the current browser state." },
  "browser.snapshot": {
    description: "Return interactive browser elements with semantic refs.",
  },
  "browser.extractText": {
    description: "Extract readable text from the current page.",
  },
  "browser.click": { description: "Click a semantic browser ref." },
  "browser.type": { description: "Type into a semantic browser ref." },
  "app.launch": { description: "Launch an allowlisted guest application." },
  "app.openFile": {
    description: "Open a sandbox file in an allowlisted application.",
  },
  "desktop.getState": { description: "Read semantic desktop state." },
  "desktop.listWindows": { description: "List visible desktop windows." },
  "desktop.focusWindow": { description: "Focus a semantic desktop window." },
  "desktop.hotkey": { description: "Send an allowlisted keyboard shortcut." },
  "desktop.type": { description: "Type text into the focused window." },
  "desktop.click": { description: "Click a desktop coordinate." },
  "desktop.screenshot": { description: "Capture the visible desktop." },
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requestIdOf(value: unknown): RpcRequestId {
  if (!isRecord(value)) {
    return null;
  }

  const id = value.id;
  if (
    (typeof id === "string" && id.length > 0 && id.length <= 256) ||
    (typeof id === "number" && Number.isFinite(id))
  ) {
    return id;
  }

  return null;
}

export function parseGuestRequest(value: unknown): GuestRequest {
  const envelope = guestRequestEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    throw new GuestRpcError(
      "INVALID_REQUEST",
      "The guest request envelope is invalid.",
      { details: envelope.error.issues, httpStatus: 400 },
    );
  }

  if (!isGuestMethod(envelope.data.method)) {
    throw new GuestRpcError(
      "METHOD_NOT_FOUND",
      `Unknown guest method: ${envelope.data.method}`,
      { httpStatus: 404 },
    );
  }

  const schema = guestMethodSchemas[envelope.data.method];
  const parsedParams = schema.safeParse(envelope.data.params);
  if (!parsedParams.success) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `Invalid params for ${envelope.data.method}.`,
      { details: parsedParams.error.issues, httpStatus: 400 },
    );
  }

  return {
    id: envelope.data.id,
    method: envelope.data.method,
    params: isRecord(envelope.data.params) ? envelope.data.params : parsedParams.data,
  };
}

export function isGuestMethod(value: string): value is GuestMethod {
  return (GUEST_METHODS as readonly string[]).includes(value);
}

export function objectParams(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GuestRpcError("INVALID_PARAMS", "Params must be a JSON object.", {
      httpStatus: 400,
    });
  }

  return value;
}

export function requiredString(
  params: Record<string, unknown>,
  key: string,
  options: { maxLength?: number } = {},
): string {
  const value = params[key];
  const maxLength = options.maxLength ?? 16_384;

  if (typeof value !== "string" || value.length === 0) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be a non-empty string.`,
      { httpStatus: 400 },
    );
  }

  if (value.length > maxLength || value.includes("\u0000")) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} is too long or contains a NUL character.`,
      { httpStatus: 400 },
    );
  }

  return value;
}

export function optionalString(
  params: Record<string, unknown>,
  key: string,
  options: { maxLength?: number } = {},
): string | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }

  return requiredString(params, key, options);
}

export function optionalBoolean(
  params: Record<string, unknown>,
  key: string,
  fallback: boolean,
): boolean {
  const value = params[key];
  if (value === undefined) {
    return fallback;
  }

  if (typeof value !== "boolean") {
    throw new GuestRpcError("INVALID_PARAMS", `${key} must be a boolean.`, {
      httpStatus: 400,
    });
  }

  return value;
}

export function optionalInteger(
  params: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = params[key];
  if (value === undefined) {
    return undefined;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    !Number.isFinite(value)
  ) {
    throw new GuestRpcError("INVALID_PARAMS", `${key} must be an integer.`, {
      httpStatus: 400,
    });
  }

  if (options.min !== undefined && value < options.min) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be at least ${options.min}.`,
      { httpStatus: 400 },
    );
  }

  if (options.max !== undefined && value > options.max) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be at most ${options.max}.`,
      { httpStatus: 400 },
    );
  }

  return value;
}

export function requiredFiniteNumber(
  params: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number {
  const value = params[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be a finite number.`,
      { httpStatus: 400 },
    );
  }

  if (options.min !== undefined && value < options.min) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be at least ${options.min}.`,
      { httpStatus: 400 },
    );
  }

  if (options.max !== undefined && value > options.max) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be at most ${options.max}.`,
      { httpStatus: 400 },
    );
  }

  return value;
}

export function optionalFiniteNumber(
  params: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): number | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new GuestRpcError("INVALID_PARAMS", `${key} must be a finite number.`, {
      httpStatus: 400,
    });
  }
  if (options.min !== undefined && value < options.min) {
    throw new GuestRpcError("INVALID_PARAMS", `${key} must be at least ${options.min}.`, {
      httpStatus: 400,
    });
  }
  if (options.max !== undefined && value > options.max) {
    throw new GuestRpcError("INVALID_PARAMS", `${key} must be at most ${options.max}.`, {
      httpStatus: 400,
    });
  }
  return value;
}

export function enumValue<T extends string>(
  params: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback?: T,
): T {
  const value = params[key];
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }

  if (typeof value !== "string" || !values.includes(value as T)) {
    throw new GuestRpcError(
      "INVALID_PARAMS",
      `${key} must be one of: ${values.join(", ")}.`,
      { httpStatus: 400 },
    );
  }

  return value as T;
}

export function successResponse<T>(
  id: RpcRequestId,
  result: T,
): GuestSuccessResponse<T> {
  return { id, ok: true, result };
}

export function failureResponse(
  id: RpcRequestId,
  error: RpcErrorPayload,
): GuestFailureResponse {
  return { id, ok: false, error };
}

interface SchemaParseSuccess<T> {
  success: true;
  data: T;
}

interface SchemaParseFailure {
  success: false;
  error: { issues: readonly unknown[] };
}

/** A small Zod-like surface for isolated guest tests and diagnostics. */
export const GuestRequestSchema = {
  safeParse(value: unknown):
    | SchemaParseSuccess<GuestRequest>
    | SchemaParseFailure {
    try {
      return { success: true, data: parseGuestRequest(value) };
    } catch (error) {
      return {
        success: false,
        error: { issues: [error instanceof Error ? error.message : error] },
      };
    }
  },
};

export const GuestResponseSchema = {
  safeParse(value: unknown):
    | SchemaParseSuccess<GuestResponse>
    | SchemaParseFailure {
    const shared = guestResponseSchema.safeParse(value);
    if (!isRecord(value)) {
      return { success: false, error: { issues: ["response must be an object"] } };
    }

    const id = value.id;
    const validId =
      id === null ||
      (typeof id === "string" && id.length > 0) ||
      (typeof id === "number" && Number.isFinite(id));
    if (!validId || typeof value.ok !== "boolean") {
      return { success: false, error: { issues: ["invalid response envelope"] } };
    }

    if (value.ok && shared.success) {
      return { success: true, data: value as unknown as GuestSuccessResponse };
    }

    if (!isRecord(value.error)) {
      return { success: false, error: { issues: ["error payload is required"] } };
    }

    if (
      typeof value.error.code !== "string" ||
      typeof value.error.message !== "string"
    ) {
      return { success: false, error: { issues: ["invalid error payload"] } };
    }

    return { success: true, data: value as unknown as GuestFailureResponse };
  },
};
