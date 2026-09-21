import { stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { GuestRpcError } from "./errors";

export type KnownCommandName =
  | "wmctrl"
  | "xdotool"
  | "gnome-screenshot"
  | "scrot"
  | "maim"
  | "text-editor"
  | "file-manager";

const COMMAND_CANDIDATES: Readonly<Record<KnownCommandName, readonly string[]>> = {
  wmctrl: ["wmctrl"],
  xdotool: ["xdotool"],
  "gnome-screenshot": ["gnome-screenshot"],
  scrot: ["scrot"],
  maim: ["maim"],
  "text-editor": ["mousepad", "xed", "gedit", "leafpad"],
  "file-manager": ["thunar", "pcmanfm", "pcmanfm-qt"],
};

export interface CommandResult {
  command: KnownCommandName;
  executable: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface CommandProcess {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array> | null | undefined;
  stderr: ReadableStream<Uint8Array> | null | undefined;
  pid?: number;
}

export interface CommandExecutor {
  run(command: KnownCommandName, args: readonly string[]): Promise<CommandResult>;
  spawn(command: KnownCommandName, args: readonly string[]): Promise<{ pid?: number }>;
  available(command: KnownCommandName): Promise<boolean>;
}

async function streamText(
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes = 2 * 1024 * 1024,
): Promise<string> {
  if (stream == null) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new GuestRpcError("COMMAND_OUTPUT_TOO_LARGE", "Known command output exceeded the limit.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

export class BunCommandExecutor implements CommandExecutor {
  private readonly environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.environment = environment;
  }

  async run(command: KnownCommandName, args: readonly string[]): Promise<CommandResult> {
    const executable = await this.resolve(command);
    let child: CommandProcess;
    try {
      child = Bun.spawn([executable, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: this.environment,
      });
    } catch {
      throw new GuestRpcError("COMMAND_START_FAILED", `Could not start ${command}.`);
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      streamText(child.stdout),
      streamText(child.stderr),
    ]);
    return { command, executable, exitCode, stdout, stderr };
  }

  async spawn(command: KnownCommandName, args: readonly string[]): Promise<{ pid?: number }> {
    const executable = await this.resolve(command);
    let child: CommandProcess;
    try {
      child = Bun.spawn([executable, ...args], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: this.environment,
      });
    } catch {
      throw new GuestRpcError("COMMAND_START_FAILED", `Could not start ${command}.`);
    }

    // A GUI process must outlive the RPC that launched it. We intentionally do
    // not await it; its lifecycle is owned by the desktop session.
    void child.exited.catch(() => undefined);
    return child.pid === undefined ? {} : { pid: child.pid };
  }

  async available(command: KnownCommandName): Promise<boolean> {
    try {
      await this.resolve(command);
      return true;
    } catch (error) {
      if (error instanceof GuestRpcError && error.code === "COMMAND_UNAVAILABLE") {
        return false;
      }
      throw error;
    }
  }

  private async resolve(command: KnownCommandName): Promise<string> {
    const candidates = COMMAND_CANDIDATES[command];
    const pathValue = this.environment.PATH ?? "";

    for (const candidate of candidates) {
      if (isAbsolute(candidate)) {
        if (await isExecutable(candidate)) return candidate;
        continue;
      }

      for (const directory of pathValue.split(delimiter)) {
        if (directory.length === 0) continue;
        const executable = join(directory, candidate);
        if (await isExecutable(executable)) return executable;
      }
    }

    throw new GuestRpcError(
      "COMMAND_UNAVAILABLE",
      `The allowlisted command for ${command} is not installed.`,
    );
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return metadata.isFile() && (metadata.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
