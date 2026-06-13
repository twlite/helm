import type { Hono } from 'hono';
import { z } from 'zod';
import {
  createConversation,
  deleteConversationById,
  getActiveRunForConversation,
  getConversationById,
  getConversationTimeline,
  getMessagesByConversationId,
  listConversationMessagesPage,
  listConversations,
  listRunEvents,
  listSummariesByConversationId,
  markRunCancelled,
  withTransaction,
} from '../database/store.ts';
import { notFound } from '../errors.ts';
import { config } from '../config.ts';
import { buildContextSummaryStats } from '../services/context-summary.ts';
import { deleteConversationMemories } from '../services/memory.ts';
import { getEffectiveSummaryContext } from '../services/model-context.ts';
import { requestRunCancellation } from '../services/run-control.ts';
import { publishRunEvent } from '../services/run-events.ts';
import { safeJsonBody } from './shared.ts';

const createConversationSchema = z.object({
  title: z.string().trim().min(1).max(140).optional(),
});

const paginationSchema = z.object({
  limit: z.coerce.number().int().positive().max(500).default(200),
  offset: z.coerce.number().int().nonnegative().default(0),
});

const timelineQuerySchema = z.object({
  includeMessages: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

const messagePageSchema = z
  .object({
    beforeCreatedAt: z.string().trim().min(1).optional(),
    beforeId: z.string().uuid().optional(),
    limit: z.coerce.number().int().positive().max(200).default(80),
  })
  .superRefine((value, context) => {
    if (value.beforeId && !value.beforeCreatedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'beforeCreatedAt is required when beforeId is provided.',
        path: ['beforeCreatedAt'],
      });
    }
  });

export const registerConversationRoutes = (app: Hono) => {
  app.get('/api/conversations', (c) => {
    const conversations = listConversations();
    return c.json({ conversations });
  });

  app.post('/api/conversations', async (c) => {
    const body = createConversationSchema.parse(await safeJsonBody(c.req.raw));
    const conversation = createConversation(body.title);
    return c.json({ conversation }, 201);
  });

  app.delete('/api/conversations/:conversationId', async (c) => {
    const conversationId = c.req.param('conversationId');
    const conversation = getConversationById(conversationId);

    if (!conversation) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const activeRun = getActiveRunForConversation(conversationId);
    if (activeRun) {
      requestRunCancellation(activeRun.id, 'Conversation deleted by user.');

      const changed = markRunCancelled({
        conversationId,
        errorMessage: 'Conversation deleted by user.',
        runId: activeRun.id,
      });

      if (changed) {
        publishRunEvent({
          conversationId,
          eventType: 'run_cancelled',
          payload: {
            message: 'Conversation deleted by user.',
          },
          runId: activeRun.id,
        });
      }
    }

    await deleteConversationMemories(conversationId);

    const deleted = withTransaction(() =>
      deleteConversationById(conversationId),
    );
    if (!deleted) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    return c.body(null, 204);
  });

  app.get('/api/conversations/:conversationId', async (c) => {
    const conversationId = c.req.param('conversationId');
    const query = timelineQuerySchema.parse(c.req.query());
    const timeline = getConversationTimeline(
      conversationId,
      query.includeMessages ?? true,
    );

    if (!timeline) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const allMessages = timeline.messages.length
      ? timeline.messages
      : getMessagesByConversationId(conversationId);
    const summaryHistory = listSummariesByConversationId(conversationId);
    const summaryContext = await getEffectiveSummaryContext({
      baseUrl: config.LLM_BASE_URL,
      fallbackTriggerTokens: config.SUMMARY_TRIGGER_TOKENS,
      modelId: config.VLM_MODEL,
    });

    return c.json({
      ...timeline,
      contextSummary: buildContextSummaryStats({
        contextWindowTokens: summaryContext.contextWindowTokens,
        messages: allMessages,
        source: summaryContext.source,
        summaries: summaryHistory,
        triggerTokens: summaryContext.triggerTokens,
      }),
      summaryHistory,
    });
  });

  app.get('/api/conversations/:conversationId/messages', (c) => {
    const conversationId = c.req.param('conversationId');
    const conversation = getConversationById(conversationId);

    if (!conversation) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const query = messagePageSchema.parse(c.req.query());

    const page = listConversationMessagesPage({
      beforeCreatedAt: query.beforeCreatedAt ?? null,
      beforeId: query.beforeId ?? null,
      conversationId,
      limit: query.limit,
    });

    return c.json(page);
  });

  app.get('/api/conversations/:conversationId/events', (c) => {
    const conversationId = c.req.param('conversationId');
    const conversation = getConversationById(conversationId);

    if (!conversation) {
      throw notFound(`Conversation ${conversationId} was not found.`);
    }

    const pagination = paginationSchema.parse(c.req.query());
    const result = listRunEvents({
      conversationId,
      limit: pagination.limit,
      offset: pagination.offset,
    });

    return c.json(result);
  });
};
