import { errorPayload } from "./errors";
import { requestIdOf } from "./protocol";
import { GuestRuntime } from "./runtime";

export type JsonlChunk = Uint8Array | string;
export type JsonlWriter = (line: string) => void | Promise<void>;

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
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
      buffer = buffer.slice(newlineIndex + 1);
      await handleLine(runtime, line, write);
      newlineIndex = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    await handleLine(runtime, buffer, write);
  }
}

async function handleLine(
  runtime: GuestRuntime,
  line: string,
  write: JsonlWriter,
): Promise<void> {
  if (line.trim().length === 0) return;

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    await write(
      JSON.stringify({
        id: null,
        ok: false,
        error: { code: "INVALID_JSON", message: "The JSONL request is malformed." },
      }) + "\n",
    );
    return;
  }

  try {
    await write(`${JSON.stringify(await runtime.dispatch(value))}\n`);
  } catch (error) {
    await write(
      JSON.stringify({
        id: requestIdOf(value),
        ok: false,
        error: errorPayload(error),
      }) + "\n",
    );
  }
}
