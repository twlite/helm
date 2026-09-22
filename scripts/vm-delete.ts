import { createInterface } from 'node:readline/promises';
import { loadConfig } from '../apps/server/src/config';
import {
  executeVmDeletion,
  formatVmDeletionPlan,
  isVmRunning,
  VmDeleteError,
} from '../apps/server/src/vm/vm-delete';

function usage(exitCode = 1): never {
  const output = [
    'Usage: bun run vm:delete [--yes] [--dry-run]',
    '',
    '  --yes       Skip the interactive confirmation prompt.',
    '  --dry-run   List the known VM files without deleting anything.',
  ].join('\n');
  (exitCode === 0 ? console.log : console.error)(output);
  process.exit(exitCode);
}

let yes = false;
let dryRun = false;
for (const argument of Bun.argv.slice(2)) {
  switch (argument) {
    case '--yes':
      yes = true;
      break;
    case '--dry-run':
      dryRun = true;
      break;
    case '--help':
    case '-h':
      usage(0);
    default:
      console.error(`Unknown option: ${argument}`);
      usage();
  }
}

async function confirmDeletion(): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question('Type "delete" to permanently remove Helm VM state: ');
    return answer.trim() === 'delete';
  } finally {
    readline.close();
  }
}

const config = loadConfig();
try {
  const result = await executeVmDeletion(config, {
    yes,
    dryRun,
    confirm: confirmDeletion,
    isVmRunning: () => isVmRunning(config),
    onPlan: plan => console.log(formatVmDeletionPlan(plan)),
  });

  if (result.dryRun) {
    console.log('\nDry run: no files were deleted.');
  } else if (result.cancelled) {
    console.log('\nDeletion cancelled.');
  } else {
    console.log([
      '',
      'Helm VM state deleted.',
      'Runtime files and backups were preserved.',
      'Run `bun run vm:provision -- ...` to create a fresh VM.',
    ].join('\n'));
  }
} catch (error) {
  console.error(error instanceof VmDeleteError ? error.message : String(error));
  process.exitCode = 1;
}
