import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { runAgentConversation } from '../agent/runtime.ts';
import { config } from '../config.ts';
import {
  appendMessage,
  createRun,
  getActiveRunForConversation,
  getConversationById,
  getRunById,
  listRunEventsByRunId,
  markRunCancelled,
  setConversationTitleIfAuto,
  withTransaction,
} from '../database/store.ts';
import { conflict, notFound } from '../errors.ts';
import { subscribeRunEvents } from '../services/event-bus.ts';
import { requestRunCancellation } from '../services/run-control.ts';
import { publishRunEvent } from '../services/run-events.ts';
import { addRunSteeringMessage } from '../services/run-steering.ts';
import { generateConversationTitle } from '../services/title.ts';
import { doneEventTypes, safeJsonBody } from './shared.ts';

const runAttachmentSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  mediaType: z.string().trim().min(1).max(255).optional(),
  url: z.string().trim().min(1).max(10_000_000),
});

const startRunSchema = z
  .object({
    attachments: z.array(runAttachmentSchema).max(12).default([]),
    input: z.string().trim().max(20_000).default(''),
    instructions: z.string().trim().max(4_000).default(''),
    reasoning: z.enum(['off', 'low', 'medium', 'high', 'on']).optional(),
  })
  .superRefine((value, context) => {
    if (value.input.trim() || value.attachments.length > 0) {
      return;
    }

    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide input text or at least one attachment.',
      path: ['input'],
    });
  });

const steerRunSchema = z.object({
  input: z.string().trim().min(1).max(20_000),
});

export const registerRunRoutes = (app: Hono) => {
  app.post('/api/conversations/:conversationId/runs', async (c) => {
    const conversationId = c.req.param('conversationId');
    const conversation = getConversationById(conversationId);

    if (!conversation) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const body = startRunSchema.parse(await safeJsonBody(c.req.raw));
    const inputText = body.input.trim();
    const reasoning = body.reasoning;
    const instructions = body.instructions.trim() || undefined;
    const attachments = body.attachments.map((attachment) => ({
      filename: attachment.filename,
      mediaType: attachment.mediaType ?? 'application/octet-stream',
      url: attachment.url,
    }));
    const existingRun = getActiveRunForConversation(conversationId);

    if (existingRun) {
      throw conflict(
        'An agent run is already active for this conversation.',
        'run_already_active',
      );
    }

    const { run, userMessage } = withTransaction(() => {
      const userMessage = appendMessage({
        conversationId,
        parts: [
          ...(inputText
            ? [{ content: { text: inputText }, type: 'text' as const }]
            : []),
          ...attachments.map((attachment) => ({
            content: {
              filename: attachment.filename,
              mediaType: attachment.mediaType,
              url: attachment.url,
            },
            type: 'attachment' as const,
          })),
        ],
        role: 'user',
        runId: null,
      });

      const nextRun = createRun({
        conversationId,
        userMessageId: userMessage.id,
      });

      publishRunEvent({
        conversationId,
        eventType: 'status',
        payload: {
          message: 'Run queued',
          status: nextRun.status,
        },
        runId: nextRun.id,
      });

      return { run: nextRun, userMessage };
    });

    queueMicrotask(() => {
      void runAgentConversation({
        conversationId,
        instructions,
        reasoning,
        runId: run.id,
        userAttachments: attachments,
        userInput:
          inputText ||
          attachments.map((attachment) => attachment.filename).join(', '),
      });
    });

    queueMicrotask(() => {
      void (async () => {
        try {
          const title = await generateConversationTitle({
            attachments,
            userInput:
              inputText ||
              attachments.map((attachment) => attachment.filename).join(', '),
          });

          setConversationTitleIfAuto(conversationId, title);
        } catch {
          // Ignore title generation failures so run execution is never impacted.
        }
      })();
    });

    return c.json({ run, userMessage }, 202);
  });

  app.post('/api/conversations/:conversationId/runs/:runId/cancel', (c) => {
    const conversationId = c.req.param('conversationId');
    const runId = c.req.param('runId');

    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const run = getRunById(runId);
    if (!run || run.conversationId !== conversationId) {
      throw notFound(
        `Run ${runId} was not found in conversation ${conversationId}.`,
      );
    }

    if (run.status === 'completed' || run.status === 'failed') {
      throw conflict('Run is already finalized and cannot be cancelled.');
    }

    requestRunCancellation(runId, 'Run cancelled by user.');

    const changed = markRunCancelled({
      conversationId,
      errorMessage: 'Run cancelled by user.',
      runId,
    });

    if (changed) {
      publishRunEvent({
        conversationId,
        eventType: 'run_cancelled',
        payload: {
          message: 'Run cancelled by user.',
        },
        runId,
      });
    }

    const refreshed = getRunById(runId);
    if (!refreshed) {
      throw notFound(
        `Run ${runId} was not found in conversation ${conversationId}.`,
      );
    }

    return c.json({ run: refreshed });
  });

  app.post('/api/conversations/:conversationId/runs/:runId/steer', async (c) => {
    const conversationId = c.req.param('conversationId');
    const runId = c.req.param('runId');
    const conversation = getConversationById(conversationId);
    if (!conversation) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const run = getRunById(runId);
    if (!run || run.conversationId !== conversationId) {
      throw notFound(
        `Run ${runId} was not found in conversation ${conversationId}.`,
      );
    }

    if (run.status !== 'queued' && run.status !== 'running') {
      throw conflict(
        'Cannot steer a run that is not active.',
        'run_not_active',
      );
    }

    const body = steerRunSchema.parse(await safeJsonBody(c.req.raw));
    const steering = addRunSteeringMessage({ runId, text: body.input });
    const message = appendMessage({
      conversationId,
      parts: [{ content: { text: body.input }, type: 'text' as const }],
      role: 'user',
      runId,
    });

    publishRunEvent({
      conversationId,
      eventType: 'status',
      payload: {
        message: 'User steering received',
        steeringCreatedAt: steering.createdAt,
        userMessageId: message.id,
      },
      runId,
    });

    return c.json({ message, ok: true, steering });
  });

  app.get(
    '/api/conversations/:conversationId/runs/:runId/stream',
    async (c) => {
      const conversationId = c.req.param('conversationId');
      const runId = c.req.param('runId');

      const conversation = getConversationById(conversationId);
      if (!conversation) {
        throw notFound(`Conversation ${conversationId} was not found.`);
      }

      const run = getRunById(runId);
      if (!run || run.conversationId !== conversationId) {
        throw notFound(
          `Run ${runId} was not found in conversation ${conversationId}.`,
        );
      }

      return streamSSE(c, async (stream) => {
        const replayEvents = listRunEventsByRunId(runId);

        for (const event of replayEvents) {
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: event.eventType,
            id: event.id,
          });
        }

        if (
          run.status === 'completed' ||
          run.status === 'failed' ||
          run.status === 'cancelled'
        ) {
          await stream.writeSSE({
            data: JSON.stringify({ runId, status: run.status }),
            event: 'done',
          });
          return;
        }

        await new Promise<void>((resolve) => {
          let finished = false;

          const cleanup = () => {
            if (finished) {
              return;
            }

            finished = true;
            clearInterval(pingTimer);
            unsubscribe();
            c.req.raw.signal.removeEventListener('abort', onAbort);
            resolve();
          };

          const onAbort = () => {
            cleanup();
          };

          const unsubscribe = subscribeRunEvents(runId, (event) => {
            void stream.writeSSE({
              data: JSON.stringify(event),
              event: event.eventType,
              id: event.id,
            });

            if (doneEventTypes.has(event.eventType)) {
              void stream.writeSSE({
                data: JSON.stringify({
                  runId,
                  status:
                    event.eventType === 'run_completed'
                      ? 'completed'
                      : event.eventType === 'run_cancelled'
                        ? 'cancelled'
                        : 'failed',
                }),
                event: 'done',
              });
              cleanup();
            }
          });

          c.req.raw.signal.addEventListener('abort', onAbort, { once: true });

          const pingTimer = setInterval(() => {
            void stream.writeSSE({
              data: JSON.stringify({ ts: Date.now() }),
              event: 'ping',
            });
          }, config.RUN_STREAM_PING_MS);
        });
      });
    },
  );
};
