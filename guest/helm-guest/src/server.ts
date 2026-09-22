import {
  createJsonlConnection,
  type JsonlConnection,
} from "./jsonl";
import { GuestRuntime } from "./runtime";

export const GUEST_TCP_HOST = "127.0.0.1";
export const GUEST_TCP_PORT = 4242;

export interface GuestTcpServerOptions {
  runtime: GuestRuntime;
  /** Test-only override; production uses 127.0.0.1:4242. */
  port?: number;
}

interface GuestSocketState {
  connection?: JsonlConnection;
  writer?: GuestSocketWriter;
}

type GuestSocket = Bun.Socket<GuestSocketState>;

interface PendingWrite {
  bytes: Uint8Array;
  offset: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

/** Serializes socket writes and waits for Bun's drain callback on backpressure. */
class GuestSocketWriter {
  private readonly encoder = new TextEncoder();
  private readonly queue: PendingWrite[] = [];
  private current: PendingWrite | undefined = undefined;
  private waitingForDrain = false;
  private closed = false;

  constructor(private readonly socket: GuestSocket) {}

  write(line: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.closed) {
        reject(new Error("Guest socket is closed."));
        return;
      }
      this.queue.push({
        bytes: this.encoder.encode(line),
        offset: 0,
        resolve,
        reject,
      });
      this.pump();
    });
  }

  drain(): void {
    this.waitingForDrain = false;
    this.pump();
  }

  close(error = new Error("Guest socket closed.")): void {
    if (this.closed) return;
    this.closed = true;
    this.current?.reject(error);
    this.current = undefined;
    for (const pending of this.queue.splice(0)) pending.reject(error);
  }

  private pump(): void {
    if (this.closed || this.waitingForDrain) return;
    if (!this.current) this.current = this.queue.shift();

    while (this.current) {
      const pending = this.current;
      let written: number;
      try {
        written = this.socket.write(
          pending.bytes,
          pending.offset,
          pending.bytes.byteLength - pending.offset,
        );
      } catch (error) {
        this.close(error instanceof Error ? error : new Error(String(error)));
        return;
      }

      if (written < 0) {
        this.close(new Error("Unable to write to the guest socket."));
        return;
      }
      if (written === 0) {
        this.waitingForDrain = true;
        return;
      }

      pending.offset += written;
      if (pending.offset < pending.bytes.byteLength) continue;

      pending.resolve();
      this.current = this.queue.shift();
    }
  }
}

export function createGuestTcpServer(options: GuestTcpServerOptions): Bun.TCPSocketListener<GuestSocketState> {
  const states = new WeakMap<GuestSocket, GuestSocketState>();
  const listener = Bun.listen<GuestSocketState>({
    hostname: GUEST_TCP_HOST,
    port: options.port ?? GUEST_TCP_PORT,
    allowHalfOpen: true,
    socket: {
      open(socket) {
        ensureSocketState(socket, options.runtime);
      },
      data(socket, data) {
        const state = ensureSocketState(socket, options.runtime);
        void state.connection?.push(data).catch(() => socket.terminate());
      },
      drain(socket) {
        states.get(socket)?.writer?.drain();
      },
      end(socket) {
        const connection = states.get(socket)?.connection;
        if (!connection) {
          socket.end();
          return;
        }
        void connection.end().catch(() => undefined).finally(() => socket.end());
      },
      error(socket, error) {
        states.get(socket)?.writer?.close(error);
      },
      close(socket) {
        states.get(socket)?.writer?.close();
        states.delete(socket);
      },
    },
  });

  return listener;

  function ensureSocketState(socket: GuestSocket, runtime: GuestRuntime): GuestSocketState {
    const existing = states.get(socket);
    if (existing) return existing;

    const writer = new GuestSocketWriter(socket);
    const connection = createJsonlConnection(runtime, line => writer.write(line));
    const state = { writer, connection };
    states.set(socket, state);
    return state;
  }
}
