import { webSocketEventSchema } from '@helm/shared';
import type { JsonValue, WebSocketEvent } from '@helm/shared';

export interface EventSocket {
  send(data: string): void;
}

export class EventHub {
  private readonly sockets = new Set<EventSocket>();

  add(socket: EventSocket): void {
    this.sockets.add(socket);
  }

  remove(socket: EventSocket): void {
    this.sockets.delete(socket);
  }

  publish(
    type: WebSocketEvent['type'],
    payload: JsonValue,
    details: { runId?: string } = {},
  ): WebSocketEvent {
    const event: WebSocketEvent = {
      type,
      timestamp: new Date().toISOString(),
      ...details,
      payload,
    };
    webSocketEventSchema.parse(event);
    const encoded = JSON.stringify(event);
    for (const socket of this.sockets) {
      try {
        socket.send(encoded);
      } catch {
        this.sockets.delete(socket);
      }
    }
    return event;
  }

  get size(): number {
    return this.sockets.size;
  }
}
