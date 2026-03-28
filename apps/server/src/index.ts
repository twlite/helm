import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { z } from 'zod';
import { config } from './config.ts';
import { ApiError } from './errors.ts';
import { registerRoutes } from './routes/index.ts';

const app = new Hono();

app.use(
  '/api/*',
  cors({
    allowHeaders: ['Content-Type'],
    allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    origin: config.CLIENT_ORIGIN ?? '*',
  }),
);

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(
      {
        error: {
          code: err.code,
          message: err.message,
        },
      },
      err.status,
    );
  }

  if (err instanceof z.ZodError) {
    return c.json(
      {
        error: {
          code: 'validation_error',
          message: err.issues.map((issue) => issue.message).join('; '),
        },
      },
      400,
    );
  }

  console.error(err);

  return c.json(
    {
      error: {
        code: 'internal_error',
        message: 'Unexpected server error',
      },
    },
    500,
  );
});

registerRoutes(app);

serve(
  {
    fetch: app.fetch,
    port: config.PORT,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
