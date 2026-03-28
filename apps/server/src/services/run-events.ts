import type { RunEventType } from '../contracts.ts';
import { appendRunEvent } from '../database/store.ts';
import { emitRunEvent } from '../services/event-bus.ts';

export const publishRunEvent = (args: {
  runId: string;
  conversationId: string;
  eventType: RunEventType;
  payload: Record<string, unknown>;
}) => {
  const event = appendRunEvent(args);
  emitRunEvent(event);
  return event;
};
