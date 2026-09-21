import { startHelmServer } from './server';

export * from './ai/adapter';
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
  const shutdown = async () => {
    await server.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}
