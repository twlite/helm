import { execFile as execFileNode } from 'node:child_process';
import { promisify } from 'node:util';

export const execFile = promisify(execFileNode);
