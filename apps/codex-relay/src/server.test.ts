import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from './server.ts';

const token = 'test-token';

const makeApp = (
  runTurn: (options: {
    onDelta?: (delta: string) => void | Promise<void>;
  }) => Promise<string>,
) =>
  createApp({
    maxBodyBytes: 1_024,
    relay: { runTurn },
    token,
  });

const request = (
  app: ReturnType<typeof createApp>,
  path: string,
  init: RequestInit = {},
) =>
  app.request(path, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });

describe('codex relay app', () => {
  it('serves health without authentication', async () => {
    const app = makeApp(async () => 'unused');
    const response = await app.request('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      service: 'codex-relay',
      status: 'ok',
    });
  });

  it('rejects protected requests with an OpenAI-shaped auth error', async () => {
    const app = makeApp(async () => 'unused');
    const response = await app.request('/v1/models');

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(await response.json(), {
      error: {
        message: 'Unauthorized',
        type: 'authentication_error',
      },
    });
  });

  it('translates a non-streaming chat completion', async () => {
    let received: unknown;
    const app = makeApp(async (options) => {
      received = options;
      return 'hello from codex';
    });
    const response = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [
          { content: 'Be concise.', role: 'system' },
          { content: 'Hello', role: 'user' },
        ],
        model: 'codex',
      }),
      method: 'POST',
    });

    assert.equal(response.status, 200);
    const body = (await response.json()) as Record<string, unknown>;
    assert.equal(body.object, 'chat.completion');
    assert.equal(body.model, 'codex');
    assert.match(String(body.id), /^chatcmpl-/);
    assert.equal(typeof body.created, 'number');
    assert.deepEqual(body.choices, [
      {
        finish_reason: 'stop',
        index: 0,
        message: {
          content: 'hello from codex',
          role: 'assistant',
        },
      },
    ]);
    assert.ok(received);
    const { signal, ...receivedWithoutSignal } = received as Record<
      string,
      unknown
    >;
    assert.ok(signal instanceof AbortSignal);
    assert.deepEqual(receivedWithoutSignal, {
      developerInstructions: 'Be concise.',
      input: [{ text: 'USER:\nHello', type: 'text' }],
    });
  });

  it('streams deltas as OpenAI-compatible SSE', async () => {
    const app = makeApp(async ({ onDelta }) => {
      await onDelta?.('hel');
      await onDelta?.('lo');
      return 'hello';
    });
    const response = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Hello', role: 'user' }],
        stream: true,
      }),
      method: 'POST',
    });

    assert.equal(response.status, 200);
    assert.match(
      response.headers.get('content-type') ?? '',
      /text\/event-stream/,
    );
    const text = await response.text();
    assert.match(text, /"role":"assistant"/);
    assert.match(text, /"content":"hel"/);
    assert.match(text, /"content":"lo"/);
    assert.match(text, /data: \[DONE\]/);
  });

  it('returns validation errors and enforces the body limit', async () => {
    const app = makeApp(async () => 'unused');
    const invalid = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({ messages: [] }),
      method: 'POST',
    });
    const oversized = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'x'.repeat(2_000), role: 'user' }],
      }),
      method: 'POST',
    });

    assert.equal(invalid.status, 400);
    assert.equal(oversized.status, 413);
  });
});
