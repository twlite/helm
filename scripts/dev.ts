import { startHelmServer } from '../apps/server/src/server';

const server = startHelmServer();
const frontend = Bun.spawn(['node', 'node_modules/vite/bin/vite.js'], {
  cwd: 'apps/web',
  stdin: 'ignore',
  stdout: 'inherit',
  stderr: 'inherit',
});

let shutdownPromise: Promise<void> | undefined;

function shutdown(signal?: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;
  if (signal) console.log(`\nReceived ${signal}; waiting for Helm development processes to shut down.`);

  shutdownPromise = (async () => {
    // Ctrl+C reaches both foreground processes. For a direct SIGTERM to this
    // supervisor, forward it to Vite before waiting for it to exit.
    if (signal === 'SIGTERM' && frontend.exitCode === null && frontend.signalCode === null) {
      frontend.kill(signal);
    }
    await frontend.exited;
    await server.close();
    if (signal) console.log('Helm development processes shut down.');
  })();
  return shutdownPromise;
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

const frontendExitCode = await frontend.exited;
if (!shutdownPromise) {
  if (frontendExitCode !== 0) {
    console.error(`Vite exited with code ${frontendExitCode}; stopping the Helm backend.`);
  }
  await shutdown();
  process.exitCode = frontendExitCode;
} else {
  await shutdownPromise;
}
