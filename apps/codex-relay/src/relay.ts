import {
  spawn,
  type ChildProcessByStdio,
} from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { config } from './config.ts';
import type { RelayInputPart } from './compat.ts';

type RpcParams = Record<string, unknown>;

export type RpcMessage = {
  jsonrpc?: '2.0';
  id?: number;
  method?: string;
  params?: RpcParams;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type RunTurnOptions = {
  developerInstructions?: string;
  input: RelayInputPart[];
  model?: string;
  onDelta?: (delta: string) => void | Promise<void>;
  onThreadCreated?: (threadId: string) => void;
  onTurnStarted?: () => void;
  signal?: AbortSignal;
  threadId?: string;
};

type PendingRequest = {
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
};

type ThreadStartResult = {
  thread?: {
    id?: string;
  };
};

type TurnStartResult = {
  turn?: {
    id?: string;
  };
};

const createAbortError = (): Error => {
  const error = new Error('The relay request was aborted.');
  error.name = 'AbortError';
  return error;
};

const errorFromUnknown = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback);

const getTurnId = (message: RpcMessage): string | undefined => {
  const direct = message.params?.turnId;

  if (typeof direct === 'string') {
    return direct;
  }

  const turn = message.params?.turn;

  if (
    turn &&
    typeof turn === 'object' &&
    !Array.isArray(turn) &&
    typeof (turn as { id?: unknown }).id === 'string'
  ) {
    return (turn as { id: string }).id;
  }

  return undefined;
};

export class CodexAppServer {
  private readonly process: ChildProcessByStdio<Writable, Readable, null>;
  private readonly cwd: string;
  private readonly model: string | undefined;
  private nextId = 1;
  private failure: Error | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private initializePromise: Promise<void> | undefined;

  private readonly pending = new Map<number, PendingRequest>();
  private readonly turnBuffers = new Map<string, RpcMessage[]>();
  private readonly turnConsumers = new Map<
    string,
    (message: RpcMessage) => void
  >();
  private readonly turnRejectors = new Map<string, (error: Error) => void>();

  constructor(options: { bin?: string; cwd?: string; model?: string } = {}) {
    this.cwd = options.cwd ?? config.codexCwd;
    this.model = options.model ?? config.codexModel;
    this.process = spawn(
      options.bin ?? config.codexBin,
      ['app-server', '--listen', 'stdio://'],
      {
        cwd: this.cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      },
    );

    const lines = createInterface({ input: this.process.stdout });

    lines.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        this.handleMessage(JSON.parse(line) as RpcMessage);
      } catch (error) {
        console.error('Invalid app-server message:', line.slice(0, 500), error);
      }
    });

    this.process.on('error', (error) => {
      this.fail(errorFromUnknown(error, 'Codex app-server failed to start.'));
    });

    this.process.stdin.on('error', (error) => {
      this.fail(errorFromUnknown(error, 'Codex app-server stdin failed.'));
    });

    this.process.on('exit', (code, signal) => {
      this.fail(
        new Error(
          signal
            ? `Codex app-server exited with signal ${signal}.`
            : `Codex app-server exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  }

  private fail(error: Error) {
    if (this.failure) {
      return;
    }

    this.failure = error;

    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }

    this.pending.clear();

    for (const reject of this.turnRejectors.values()) {
      reject(error);
    }

    this.turnRejectors.clear();
    this.turnConsumers.clear();
    this.turnBuffers.clear();
  }

  private send(message: RpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const write = this.writeQueue.then(async () => {
      if (this.failure) {
        throw this.failure;
      }

      if (!this.process.stdin.writable) {
        throw new Error('Codex app-server stdin is not writable.');
      }

      if (!this.process.stdin.write(line)) {
        await once(this.process.stdin, 'drain');
      }
    });

    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private handleMessage(message: RpcMessage) {
    const isResponse =
      message.id !== undefined &&
      !message.method &&
      ('result' in message || 'error' in message);

    if (isResponse) {
      const request = this.pending.get(message.id as number);

      if (!request) {
        return;
      }

      this.pending.delete(message.id as number);
      request.cleanup();

      if (message.error) {
        request.reject(
          new Error(
            `Codex RPC ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        request.resolve(message.result);
      }

      return;
    }

    if (message.method && message.id !== undefined) {
      void this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: -32601,
          message: `Unsupported app-server request: ${message.method}`,
        },
      }).catch((error: unknown) => {
        this.fail(errorFromUnknown(error, 'Could not answer app-server request.'));
      });

      return;
    }

    const turnId = getTurnId(message);

    if (!turnId) {
      return;
    }

    const consumer = this.turnConsumers.get(turnId);

    if (consumer) {
      consumer(message);
      return;
    }

    const buffer = this.turnBuffers.get(turnId) ?? [];

    if (buffer.length < 512) {
      buffer.push(message);
      this.turnBuffers.set(turnId, buffer);
    }
  }

  call<T = unknown>(
    method: string,
    params?: RpcParams,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const request = this.pending.get(id);

        if (!request) {
          return;
        }

        this.pending.delete(id);
        request.cleanup();
        reject(createAbortError());
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      this.pending.set(id, {
        cleanup,
        reject,
        resolve: (result) => resolve(result as T),
      });

      signal?.addEventListener('abort', onAbort, { once: true });

      void this.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }).catch((error: unknown) => {
        const request = this.pending.get(id);

        if (!request) {
          return;
        }

        this.pending.delete(id);
        request.cleanup();
        reject(errorFromUnknown(error, `Codex RPC ${method} failed.`));
      });
    });
  }

  notify(method: string, params?: RpcParams) {
    void this.send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }).catch((error: unknown) => {
      this.fail(errorFromUnknown(error, `Codex notification ${method} failed.`));
    });
  }

  async initialize() {
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce() {
    await this.call('initialize', {
      capabilities: {},
      clientInfo: {
        name: 'helm-openai-relay',
        title: 'Helm OpenAI Relay',
        version: '0.1.0',
      },
    });

    this.notify('initialized');

    const account = await this.call<{
      account?: {
        planType?: string;
        type?: string;
      };
    }>('account/read', { refreshToken: false });

    console.log(
      'Codex account:',
      account.account?.type ?? 'none',
      account.account?.planType ?? '',
    );
  }

  async runTurn({
    developerInstructions,
    input,
    model,
    onDelta,
    onThreadCreated,
    onTurnStarted,
    signal,
    threadId,
  }: RunTurnOptions): Promise<string> {
    if (signal?.aborted) {
      throw createAbortError();
    }

    let activeThreadId = threadId;

    if (!activeThreadId) {
      const effectiveModel = model ?? this.model;
      const thread = await this.call<ThreadStartResult>(
        'thread/start',
        {
          approvalPolicy: 'never',
          cwd: this.cwd,
          ephemeral: true,
          ...(effectiveModel ? { model: effectiveModel } : {}),
          sandbox: 'read-only',
          ...(developerInstructions ? { developerInstructions } : {}),
        },
        signal,
      );

      activeThreadId = thread.thread?.id;

      if (!activeThreadId) {
        throw new Error('Codex did not return a thread id.');
      }

      onThreadCreated?.(activeThreadId);
    }

    const started = await this.call<TurnStartResult>(
      'turn/start',
      {
        input,
        ...(model ? { model } : {}),
        threadId: activeThreadId,
      },
      signal,
    );

    const turnId = started.turn?.id;

    if (!turnId) {
      throw new Error('Codex did not return a turn id.');
    }

    onTurnStarted?.();

    return new Promise<string>((resolve, reject) => {
      if (this.failure) {
        reject(this.failure);
        return;
      }

      let text = '';
      let settled = false;

      const cleanup = () => {
        this.turnConsumers.delete(turnId);
        this.turnRejectors.delete(turnId);
        this.turnBuffers.delete(turnId);
        signal?.removeEventListener('abort', onAbort);
      };

      const settleError = (error: Error) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error);
      };

      const onAbort = () => {
        if (settled) {
          return;
        }

        settled = true;
        this.turnConsumers.set(turnId, (message) => {
          if (message.method === 'turn/completed') {
            this.turnConsumers.delete(turnId);
            this.turnBuffers.delete(turnId);
          }
        });
        this.turnRejectors.delete(turnId);
        this.turnBuffers.delete(turnId);
        signal?.removeEventListener('abort', onAbort);

        void this.call('turn/interrupt', {
          threadId: activeThreadId,
          turnId,
        }).catch(() => {
          // The request is already being aborted; the app-server may have
          // completed the turn before it received the interrupt.
        });

        reject(createAbortError());
      };

      const consume = (message: RpcMessage) => {
        if (settled) {
          return;
        }

        if (message.method === 'item/agentMessage/delta') {
          const delta = message.params?.delta;

          if (typeof delta === 'string') {
            text += delta;

            try {
              const callback = onDelta?.(delta);

              if (callback) {
                void callback.catch((error: unknown) => {
                  settleError(
                    errorFromUnknown(error, 'Relay delta handler failed.'),
                  );
                });
              }
            } catch (error) {
              settleError(errorFromUnknown(error, 'Relay delta handler failed.'));
            }
          }

          return;
        }

        if (message.method !== 'turn/completed') {
          return;
        }

        const turn = message.params?.turn;
        const turnStatus =
          turn &&
          typeof turn === 'object' &&
          !Array.isArray(turn) &&
          typeof (turn as { status?: unknown }).status === 'string'
            ? (turn as { status: string }).status
            : undefined;

        if (turnStatus === 'failed') {
          settleError(
            new Error(
              turn &&
                typeof turn === 'object' &&
                !Array.isArray(turn) &&
                typeof (turn as { error?: { message?: unknown } }).error
                  ?.message === 'string'
                ? (turn as { error: { message: string } }).error.message
                : 'Codex turn failed.',
            ),
          );
          return;
        }

        if (turnStatus === 'interrupted') {
          settleError(new Error('Codex turn was interrupted.'));
          return;
        }

        settled = true;
        cleanup();
        resolve(text);
      };

      this.turnRejectors.set(turnId, settleError);
      this.turnConsumers.set(turnId, consume);

      const buffered = this.turnBuffers.get(turnId);

      if (buffered) {
        this.turnBuffers.delete(turnId);

        for (const event of buffered) {
          consume(event);
        }
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });

        if (signal.aborted) {
          onAbort();
        }
      }
    });
  }

  close() {
    this.fail(new Error('Codex app-server is shutting down.'));

    if (!this.process.killed && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
    }
  }
}
