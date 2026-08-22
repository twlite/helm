import { randomUUID } from 'node:crypto';
import { bodyLimit } from 'hono/body-limit';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import {
  parseChatCompletionRequest,
  RelayValidationError,
} from './compat.ts';
import type { CodexAppServer, RunTurnOptions } from './relay.ts';

type RelayService = Pick<CodexAppServer, 'runTurn'>;

type AppOptions = {
  maxBodyBytes: number;
  modelId?: string;
  relay: RelayService;
  token: string;
};

const errorBody = (message: string, type = 'relay_error') => ({
  error: {
    message,
    type,
  },
});

const isAbortError = (error: unknown): boolean =>
  error instanceof Error && error.name === 'AbortError';

const parseBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'BodyLimitError') {
      throw error;
    }

    throw new RelayValidationError('Request body must be valid JSON.');
  }
};

const createCompletionId = () => `chatcmpl-${randomUUID()}`;

const createApp = ({
  maxBodyBytes,
  modelId = 'codex',
  relay,
  token,
}: AppOptions) => {
  const app = new Hono();

  app.use('/v1/*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${token}`) {
      c.header('WWW-Authenticate', 'Bearer');
      return c.json(errorBody('Unauthorized', 'authentication_error'), 401);
    }

    await next();
  });

  app.get('/health', (c) => c.json({ service: 'codex-relay', status: 'ok' }));

  app.get('/v1/models', (c) =>
    c.json({
      data: [
        {
          id: modelId,
          object: 'model',
          owned_by: 'local',
        },
      ],
      object: 'list',
    }),
  );

  app.post(
    '/v1/chat/completions',
    bodyLimit({
      maxSize: maxBodyBytes,
      onError: (c) =>
        c.json(
          errorBody(
            'Request body exceeds the relay size limit.',
            'invalid_request_error',
          ),
          413,
        ),
    }),
    async (c) => {
      const request = parseChatCompletionRequest(await parseBody(c.req.raw));
      const id = createCompletionId();
      const created = Math.floor(Date.now() / 1000);
      const turn: RunTurnOptions = {
        developerInstructions: request.developerInstructions,
        input: request.input,
        signal: c.req.raw.signal,
      };

      if (!request.stream) {
        const text = await relay.runTurn(turn);

        return c.json({
          choices: [
            {
              finish_reason: 'stop',
              index: 0,
              message: {
                content: text,
                role: 'assistant',
              },
            },
          ],
          created,
          id,
          model: request.model,
          object: 'chat.completion',
        });
      }

      c.header('Cache-Control', 'no-cache, no-transform');
      c.header('X-Accel-Buffering', 'no');

      return streamSSE(c, async (stream) => {
        let writeChain: Promise<void> = Promise.resolve();
        const signal = c.req.raw.signal;

        const enqueueRaw = (data: string): Promise<void> => {
          writeChain = writeChain.then(async () => {
            if (!signal.aborted) {
              await stream.writeSSE({ data });
            }
          });

          return writeChain;
        };

        const enqueue = (data: unknown) => enqueueRaw(JSON.stringify(data));

        const chunk = (delta: Record<string, unknown>) => ({
          choices: [
            {
              delta,
              finish_reason: null,
              index: 0,
            },
          ],
          created,
          id,
          model: request.model,
          object: 'chat.completion.chunk',
        });

        await enqueue(chunk({ role: 'assistant' }));

        try {
          await relay.runTurn({
            ...turn,
            onDelta: (delta) => enqueue(chunk({ content: delta })),
          });

          await writeChain;

          if (!signal.aborted) {
            await enqueue(chunk({}));
            await enqueueRaw('[DONE]');
          }
        } catch (error) {
          await writeChain;

          if (!signal.aborted && !isAbortError(error)) {
            await enqueue(
              errorBody(
                error instanceof Error ? error.message : 'Relay request failed.',
              ),
            );
          }
        }
      });
    },
  );

  app.notFound((c) =>
    c.json(errorBody('Not found', 'invalid_request_error'), 404),
  );

  app.onError((error, c) => {
    if (error instanceof Error && error.name === 'BodyLimitError') {
      return c.json(
        errorBody(
          'Request body exceeds the relay size limit.',
          'invalid_request_error',
        ),
        413,
      );
    }

    if (error instanceof RelayValidationError) {
      return c.json(errorBody(error.message, 'invalid_request_error'), 400);
    }

    if (error instanceof HTTPException) {
      return error.getResponse();
    }

    if (isAbortError(error) || c.req.raw.signal.aborted) {
      return c.json(errorBody('The relay request was aborted.'), 408);
    }

    console.error('Relay request failed:', error);
    return c.json(errorBody('The relay request failed.'), 500);
  });

  return app;
};

export { createApp };
