import { loadConfig } from '../apps/server/src/config';
import { virtualizationHelperAvailable } from '../apps/server/src/vm/helper';

function usage(exitCode = 1): never {
  console.error('Usage: bun run vm:maintenance');
  process.exit(exitCode);
}

if (Bun.argv.length > 2) {
  if (Bun.argv[2] === '--help' || Bun.argv[2] === '-h') usage(0);
  usage();
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('VM maintenance requires an Apple Silicon macOS host.');
  process.exit(1);
}

const config = loadConfig();
if (!virtualizationHelperAvailable(config.vmHelperPath)) {
  console.error(`Signed Virtualization.framework helper not found at ${config.vmHelperPath}`);
  console.error('Run `bun run vm:build` first, then retry maintenance mode.');
  process.exit(1);
}

const helper = Bun.spawn([
  config.vmHelperPath,
  '--show-window',
  '--root', config.dataDir,
  '--base-image', config.baseImagePath,
  '--working-image', config.workingImagePath,
  '--efi-vars', config.efiVariablesPath,
  '--machine-id', config.machineIdentifierPath,
  '--runtime-share', config.runtimeDir,
  '--runtime-tag', config.runtimeTag,
  '--guest-port', String(config.guestPort),
  '--memory-mib', String(config.vmMemoryMb),
  '--cpus', String(config.vmCpus),
], {
  stdin: 'pipe',
  stdout: 'inherit',
  stderr: 'inherit',
});

// The helper remains a JSONL host. Start it once, then forward any subsequent
// stdin commands so maintenance work can still use vm.status, vm.stop, reset,
// and guestRequest without starting the guest runtime.
helper.stdin.write(`${JSON.stringify({ id: 'maintenance-start', method: 'vm.start', params: {} })}\n`);

const inputController = new AbortController();
const forwardInput = Bun.stdin.stream().pipeTo(
  new WritableStream<Uint8Array>({
    write(chunk) {
      if (helper.exitCode === null) helper.stdin.write(chunk);
    },
    close() {
      helper.stdin.end();
    },
    abort() {
      helper.stdin.end();
    },
  }),
  { signal: inputController.signal },
).catch(() => undefined);

const exitCode = await helper.exited;
inputController.abort();
await forwardInput;
process.exitCode = exitCode;
