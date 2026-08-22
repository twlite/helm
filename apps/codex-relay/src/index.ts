import { serve } from '@hono/node-server';
import { config } from './config.ts';
import { CodexAppServer } from './relay.ts';
import { createApp } from './server.ts';
import { RelaySessionStore } from './session-store.ts';

try {
  process.loadEnvFile();
} catch {}

const relay = new CodexAppServer({
  bin: config.codexBin,
  cwd: config.codexCwd,
  model: config.codexModel,
});
const sessions = new RelaySessionStore({
  sweepIntervalMs: Math.min(config.sessionTtlMs, 60_000),
  ttlMs: config.sessionTtlMs,
});

try {
  await relay.initialize();
} catch (error) {
  relay.close();
  console.error('Could not initialize Codex app-server:', error);
  process.exitCode = 1;
  throw error;
}

const app = createApp({
  maxBodyBytes: config.maxBodyBytes,
  modelId: config.codexModel,
  relay,
  sessions,
  token: config.relayToken,
});

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(
      `Codex relay is listening on http://${info.address}:${info.port}`,
    );
  },
);

let shuttingDown = false;

const shutdown = (signal: string) => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down Codex relay.`);
  sessions.close();
  relay.close();

  server.close((error) => {
    if (error) {
      console.error('Could not close relay server:', error);
      process.exitCode = 1;
    }
  });
};

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
