import { errorPayload } from "./errors";
import { failureResponse, requestIdOf } from "./protocol";
import { GuestRuntime } from "./runtime";

export type JsonlChunk = Uint8Array | string;
export type JsonlWriter = (line: string) => void | Promise<void>;
export const MAX_JSONL_FRAME_BYTES = 64 * 1024 * 1024;

export interface JsonlConnection {
  push(chunk: JsonlChunk): Promise<void>;
  end(): Promise<void>;
}

export async function* readableStreamChunks(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Serve one request per line without allowing malformed input to kill Bun. */
export async function serveJsonLines(
  runtime: GuestRuntime,
  input: AsyncIterable<JsonlChunk>,
  write: JsonlWriter,
): Promise<void> {
  const connection = createJsonlConnection(runtime, write);

  for await (const chunk of input) {
    await connection.push(chunk);
  }

  await connection.end();
}

/**
 * Creates a serialized JSONL session for a byte stream such as a TCP socket.
 * Chunks may split a UTF-8 code point or contain several complete frames.
 */
export function createJsonlConnection(
  runtime: GuestRuntime,
  write: JsonlWriter,
): JsonlConnection {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  let discardingOversizedFrame = false;
  let ended = false;
  let operations = Promise.resolve();

  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const next = operations.then(operation);
    operations = next.catch(() => undefined);
    return next;
  };

  const consume = async (chunk: JsonlChunk): Promise<void> => {
    let remaining: Uint8Array<ArrayBufferLike> =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;

    while (remaining.byteLength > 0) {
      if (discardingOversizedFrame) {
        const newlineIndex = remaining.indexOf(0x0a);
        if (newlineIndex < 0) return;
        remaining = remaining.slice(newlineIndex + 1);
        discardingOversizedFrame = false;
        continue;
      }

      const newlineIndex = remaining.indexOf(0x0a);
      if (newlineIndex < 0) {
        buffer = concatBytes(buffer, remaining);
        if (buffer.byteLength > MAX_JSONL_FRAME_BYTES) {
          buffer = new Uint8Array(0);
          discardingOversizedFrame = true;
          await writeFailure(null, "REQUEST_TOO_LARGE", "The JSONL request frame is too large.", write);
        }
        return;
      }

      const frame = concatBytes(buffer, remaining.slice(0, newlineIndex));
      buffer = new Uint8Array(0);
      remaining = remaining.slice(newlineIndex + 1);

      if (frame.byteLength > MAX_JSONL_FRAME_BYTES) {
        await writeFailure(null, "REQUEST_TOO_LARGE", "The JSONL request frame is too large.", write);
        continue;
      }

      await handleFrame(runtime, frame, write, decoder);
    }
  };

  return {
    push(chunk: JsonlChunk): Promise<void> {
      if (ended) return operations;
      return enqueue(() => consume(chunk));
    },
    end(): Promise<void> {
      if (ended) return operations;
      ended = true;
      return enqueue(async () => {
        if (discardingOversizedFrame || buffer.byteLength === 0) return;
        if (buffer.byteLength > MAX_JSONL_FRAME_BYTES) {
          await writeFailure(null, "REQUEST_TOO_LARGE", "The JSONL request frame is too large.", write);
          return;
        }
        const frame = buffer;
        buffer = new Uint8Array(0);
        await handleFrame(runtime, frame, write, decoder);
      });
    },
  };
}

function concatBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

async function handleFrame(
  runtime: GuestRuntime,
  frame: Uint8Array,
  write: JsonlWriter,
  decoder: TextDecoder,
): Promise<void> {
  let line: string;
  try {
    line = decoder.decode(frame);
  } catch {
    await writeFailure(null, "INVALID_UTF8", "The JSONL request was not valid UTF-8.", write);
    return;
  }

  if (line.trim().length === 0) return;

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    await writeFailure(null, "INVALID_JSON", "The JSONL request is malformed.", write);
    return;
  }

  try {
    await writeResponse(await runtime.dispatch(value), write);
  } catch (error) {
    await writeResponse(failureResponse(requestIdOf(value), errorPayload(error)), write);
  }
}

async function writeFailure(
  id: ReturnType<typeof requestIdOf>,
  code: string,
  message: string,
  write: JsonlWriter,
): Promise<void> {
  await writeResponse(failureResponse(id, { code, message }), write);
}

async function writeResponse(response: unknown, write: JsonlWriter): Promise<void> {
  const line = `${JSON.stringify(response)}\n`;
  if (new TextEncoder().encode(line).byteLength > MAX_JSONL_FRAME_BYTES) {
    const id = requestIdOf(response);
    await write(
      `${JSON.stringify(failureResponse(id, {
        code: "RESPONSE_TOO_LARGE",
        message: "The JSONL response frame is too large.",
      }))}\n`,
    );
    return;
  }
  await write(line);
}
