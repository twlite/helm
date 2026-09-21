import { createGuestHttpHandler } from "./server";
import { readableStreamChunks, serveJsonLines } from "./jsonl";
import { GuestRuntime } from "./runtime";

export * from "./apps";
export * from "./browser";
export * from "./commands";
export * from "./desktop";
export * from "./errors";
export * from "./jsonl";
export * from "./protocol";
export * from "./runtime";
export * from "./sandbox";
export * from "./server";

interface GuestCliOptions {
  jsonl: boolean;
  host: string;
  port: number;
}

function cliOptions(): GuestCliOptions {
  const jsonl =
    process.argv.includes("--jsonl") || process.env.HELM_GUEST_TRANSPORT === "jsonl";
  const host = process.env.HELM_GUEST_HOST ?? "127.0.0.1";
  const portValue = process.env.HELM_GUEST_PORT ?? process.env.PORT ?? "4242";
  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("HELM_GUEST_PORT must be an integer between 0 and 65535.");
  }
  return { jsonl, host, port };
}

async function run(): Promise<void> {
  const options = cliOptions();
  const runtime = new GuestRuntime();

  if (options.jsonl) {
    await serveJsonLines(
      runtime,
      readableStreamChunks(Bun.stdin.stream()),
      (line) => {
        process.stdout.write(line);
      },
    );
    await runtime.close();
    return;
  }

  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: createGuestHttpHandler({ runtime }),
  });
  process.stderr.write(`helm-guest listening on http://${options.host}:${server.port}/rpc\n`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.stop();
    await runtime.close();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  await new Promise<void>(() => undefined);
}

if (import.meta.main) {
  await run().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "guest startup failed";
    process.stderr.write(`helm-guest: ${message}\n`);
    process.exitCode = 1;
  });
}
