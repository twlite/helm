import { startHelmServer } from './server';

export * from './ai';
export * from './config';
export * from './events';
export * from './server';
export * from './db';
export * from './memory';
export * from './agent';
export * from './tools';
export * from './vm/vm-controller';

if (import.meta.main) {
  const server = startHelmServer();
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.info(`Received ${signal}; shutting down Helm server and VM.`);
    await server.close();
    console.info('Helm server shutdown complete.');
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}
