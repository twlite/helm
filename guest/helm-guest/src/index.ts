import { createGuestTcpServer, GUEST_TCP_HOST, GUEST_TCP_PORT } from "./server";
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
}

function cliOptions(): GuestCliOptions {
  const jsonl =
    process.argv.includes("--jsonl") || process.env.HELM_GUEST_TRANSPORT === "jsonl";
  return { jsonl };
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

  const server = createGuestTcpServer({ runtime });
  process.stderr.write(`helm-guest listening on tcp://${GUEST_TCP_HOST}:${GUEST_TCP_PORT} (JSONL)\n`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
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
