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
  // Keep Vite and any runtime shim it starts in one process group so an
  // unexpected backend exit cannot leave the frontend listener orphaned.
  detached: true,
});

let shuttingDown = false;
let shutdownExitCode = 0;
const shutdown = (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}; waiting for Helm development processes to shut down.`);

  // Both services are detached from the terminal process group, so signal
  // them explicitly. The backend handles VM shutdown; Vite may have a runtime
  // shim and needs a process-group signal.
  if (server.exitCode === null && server.signalCode === null) server.kill(signal);
  signalProcessGroup(frontend.pid, signal);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function signalProcessGroup(processId: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return;
  try {
    process.kill(-processId, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

function processGroupExists(processId: number): boolean {
  if (process.platform === 'win32') return false;
  try {
    process.kill(-processId, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    return true;
  }
}

async function waitForFrontendProcessGroup(): Promise<void> {
  if (process.platform === 'win32') return;
  const deadline = Date.now() + 5_000;
  while (processGroupExists(frontend.pid) && Date.now() < deadline) await Bun.sleep(25);
  if (processGroupExists(frontend.pid)) signalProcessGroup(frontend.pid, 'SIGKILL');
}

const watchChild = async (name: string, child: Bun.Subprocess): Promise<void> => {
  const exitCode = await child.exited;
  if (shuttingDown) return;

  shuttingDown = true;
  shutdownExitCode = child.signalCode === null ? exitCode : 1;
  const exitReason = child.signalCode ? `from signal ${child.signalCode}` : `with code ${exitCode}`;
  console.error(`\nHelm ${name} process exited unexpectedly ${exitReason}; stopping the other development process.`);
  if (child !== frontend) signalProcessGroup(frontend.pid, 'SIGTERM');
  if (child !== server && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
  }
};

await Promise.all([
  watchChild('backend', server),
  watchChild('frontend', frontend),
]);
await waitForFrontendProcessGroup();
process.exitCode = shutdownExitCode;
