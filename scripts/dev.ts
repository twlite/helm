const server = Bun.spawn(['bun', 'src/index.ts'], {
  cwd: 'apps/server',
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
  // Isolate the backend and any VM host it starts from terminal Ctrl+C. The
  // supervisor can then signal the backend, which stops the VM over JSONL.
  detached: true,
});

const frontend = Bun.spawn(['node', 'node_modules/vite/bin/vite.js'], {
  cwd: 'apps/web',
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const children = [server, frontend];

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}; waiting for Helm development processes to shut down.`);

  // Ctrl+C is broadcast to the foreground process group, so Vite is already
  // stopping. Forward it only to the isolated backend, which owns the VM.
  // For other signals, forward to both child processes.
  const targets = signal === 'SIGINT' ? [server] : children;
  for (const child of targets) {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const results = await Promise.all(children.map(child => child.exited));
if (!shuttingDown && results.some(code => code !== 0)) process.exit(1);
