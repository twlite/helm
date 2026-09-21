const children = [
  Bun.spawn(['bun', 'run', '--cwd', 'apps/server', 'dev'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }),
  Bun.spawn(['bun', 'run', '--cwd', 'apps/web', 'dev'], {
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  }),
];

let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}; stopping Helm development processes.`);
  for (const child of children) child.kill();
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

const results = await Promise.all(children.map(child => child.exited));
if (!shuttingDown && results.some(code => code !== 0)) process.exit(1);
