import { asGuestRpcError, errorPayload, GuestRpcError } from "./errors";
import { failureResponse, type GuestResponse } from "./protocol";
import { GuestRuntime } from "./runtime";

const MAX_HTTP_BODY_BYTES = 2 * 1024 * 1024;

export interface GuestHttpHandlerOptions {
  runtime: GuestRuntime;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function readLimitedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (reader === undefined) return "";

  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_HTTP_BODY_BYTES) {
        throw new GuestRpcError("REQUEST_TOO_LARGE", "The request body is too large.", {
          httpStatus: 413,
        });
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

export function createGuestHttpHandler(
  options: GuestHttpHandlerOptions,
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      try {
        return jsonResponse({ ok: true, health: await options.runtime.health() });
      } catch (error) {
        const normalized = asGuestRpcError(error);
        return jsonResponse(
          { ok: false, error: errorPayload(normalized) },
          normalized.httpStatus,
        );
      }
    }

    if (url.pathname !== "/rpc" && url.pathname !== "/") {
      return jsonResponse(
        failureResponse(null, {
          code: "NOT_FOUND",
          message: "The guest endpoint was not found.",
        }),
        404,
      );
    }

    if (request.method !== "POST") {
      return jsonResponse(
        failureResponse(null, {
          code: "METHOD_NOT_ALLOWED",
          message: "Guest RPC requests must use POST.",
        }),
        405,
      );
    }

    try {
      const rawBody = await readLimitedBody(request);
      let value: unknown;
      try {
        value = JSON.parse(rawBody);
      } catch {
        return jsonResponse(
          failureResponse(null, {
            code: "INVALID_JSON",
            message: "The request body is not valid JSON.",
          }),
          400,
        );
      }

      const response = await options.runtime.dispatch(value);
      return jsonResponse(response, responseStatus(response));
    } catch (error) {
      const normalized = asGuestRpcError(error);
      return jsonResponse(
        failureResponse(null, errorPayload(normalized)),
        normalized.httpStatus,
      );
    }
  };
}

function responseStatus(response: GuestResponse): number {
  if (response.ok) return 200;
  if (response.error.code === "INVALID_REQUEST" || response.error.code === "INVALID_PARAMS") {
    return 400;
  }
  if (response.error.code === "METHOD_NOT_FOUND") return 404;
  return 200;
}
