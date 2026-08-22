import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RelayTurnResult } from './compat.ts';
import type { RunTurnOptions } from './relay.ts';
import { createApp } from './server.ts';
import { RelaySessionStore } from './session-store.ts';

const token = 'test-token';

const answer = (text: string): RelayTurnResult => ({
  text,
  toolCalls: [],
});

const makeApp = (
  runTurn: (options: RunTurnOptions) => Promise<RelayTurnResult>,
  sessions?: RelaySessionStore,
) =>
  createApp({
    maxBodyBytes: 1_024,
    relay: { runTurn },
    sessions,
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
    const app = makeApp(async () => answer('unused'));
    const response = await app.request('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      service: 'codex-relay',
      status: 'ok',
    });
  });

  it('rejects protected requests with an OpenAI-shaped auth error', async () => {
    const app = makeApp(async () => answer('unused'));
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
      return answer('hello from codex');
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
      history: [
        {
          kind: 'input',
          part: { text: 'USER:\nHello', type: 'text' },
        },
      ],
      input: [{ text: 'USER:\nHello', type: 'text' }],
      model: 'codex',
    });
  });

  it('streams deltas as OpenAI-compatible SSE', async () => {
    const app = makeApp(async ({ onDelta }) => {
      await onDelta?.('hel');
      await onDelta?.('lo');
      return answer('hello');
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

  it('returns dynamic tool calls and resumes the same session with an image result', async () => {
    const received: RunTurnOptions[] = [];
    const sessions = new RelaySessionStore({ ttlMs: 60_000 });
    const app = makeApp(async (options) => {
      received.push(options);

      if (!options.threadId) {
        options.onThreadCreated?.('thread-tools');
        return {
          text: '',
          threadId: 'thread-tools',
          toolCalls: [
            {
              arguments: '{}',
              id: 'call-screenshot',
              name: 'screenshot',
            },
          ],
          turnId: 'turn-tools',
        };
      }

      return { text: 'The screen is ready.', toolCalls: [] };
    }, sessions);
    const tools = [
      {
        function: {
          description: 'Capture the current screen.',
          name: 'screenshot',
          parameters: { properties: {}, type: 'object' },
        },
        type: 'function',
      },
    ];

    const first = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'What do you see?', role: 'user' }],
        tools,
      }),
      headers: { 'X-Helm-Session': 'helm-tools' },
      method: 'POST',
    });
    const firstBody = (await first.json()) as Record<string, any>;

    assert.equal(first.status, 200);
    assert.equal(firstBody.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(firstBody.choices[0].message.tool_calls, [
      {
        function: { arguments: '{}', name: 'screenshot' },
        id: 'call-screenshot',
        type: 'function',
      },
    ]);
    assert.deepEqual(received[0]?.tools, [
      {
        description: 'Capture the current screen.',
        inputSchema: { properties: {}, type: 'object' },
        name: 'screenshot',
      },
    ]);

    const second = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [
          { content: 'What do you see?', role: 'user' },
          {
            content: null,
            role: 'assistant',
            tool_calls: [
              {
                function: {
                  arguments: '{}',
                  name: 'screenshot',
                },
                id: 'call-screenshot',
                type: 'function',
              },
            ],
          },
          {
            content: JSON.stringify([
              { text: 'Screenshot captured.' },
              { data: 'AQ==', mediaType: 'image/png', type: 'media' },
            ]),
            role: 'tool',
            tool_call_id: 'call-screenshot',
          },
        ],
        tools,
      }),
      headers: { 'X-Helm-Session': 'helm-tools' },
      method: 'POST',
    });
    const secondBody = (await second.json()) as Record<string, any>;

    assert.equal(second.status, 200);
    assert.equal(secondBody.choices[0].message.content, 'The screen is ready.');
    assert.equal(received[1]?.threadId, 'thread-tools');
    assert.equal(received[1]?.continuationTurnId, 'turn-tools');
    assert.deepEqual(received[1]?.input, []);
    assert.deepEqual(received[1]?.toolResults, [
      {
        content: [
          { text: 'Screenshot captured.', type: 'text' },
          { type: 'image', url: 'data:image/png;base64,AQ==' },
        ],
        toolCallId: 'call-screenshot',
      },
    ]);
  });

  it('streams dynamic tool calls with the OpenAI tool_calls finish reason', async () => {
    const app = makeApp(async () => ({
      text: '',
      threadId: 'thread-stream-tools',
      toolCalls: [
        {
          arguments: '{"x":1}',
          id: 'call-click',
          name: 'click',
        },
      ],
      turnId: 'turn-stream-tools',
    }));
    const response = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'Click it.', role: 'user' }],
        stream: true,
        tools: [
          {
            function: {
              name: 'click',
              parameters: { properties: { x: { type: 'number' } }, type: 'object' },
            },
            type: 'function',
          },
        ],
      }),
      method: 'POST',
    });
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.match(text, /"tool_calls":\[\{"function":\{"arguments":"\{\\"x\\":1\}","name":"click"\},"id":"call-click","index":0,"type":"function"\}\]/);
    assert.match(text, /"finish_reason":"tool_calls"/);
  });

  it('returns validation errors and enforces the body limit', async () => {
    const app = makeApp(async () => answer('unused'));
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

  it('allows protected endpoints when no relay token is configured', async () => {
    const app = createApp({
      maxBodyBytes: 1_024,
      relay: { runTurn: async () => answer('unused') },
    });
    const response = await app.request('/v1/models');

    assert.equal(response.status, 200);
    assert.equal((await response.json()).object, 'list');
  });

  it('reuses a Codex thread and sends only the incremental session turn', async () => {
    const received: RunTurnOptions[] = [];
    const sessions = new RelaySessionStore({ ttlMs: 60_000 });
    const app = makeApp(async (options) => {
      received.push(options);
      if (!options.threadId) {
        options.onThreadCreated?.('thread-1');
      }
      options.onTurnStarted?.();
      return answer('First answer');
    }, sessions);

    const first = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [
          { content: 'Be concise.', role: 'system' },
          { content: 'First turn', role: 'user' },
        ],
      }),
      headers: { 'X-Helm-Session': 'helm-session-1' },
      method: 'POST',
    });
    const second = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [
          { content: 'Be concise.', role: 'system' },
          { content: 'First turn', role: 'user' },
          { content: 'First answer', role: 'assistant' },
          { content: 'Second turn', role: 'user' },
        ],
      }),
      headers: { 'X-Helm-Session': 'helm-session-1' },
      method: 'POST',
    });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(received.length, 2);
    assert.equal(received[0]?.threadId, undefined);
    assert.equal(received[1]?.threadId, 'thread-1');
    assert.equal(received[1]?.developerInstructions, undefined);
    assert.deepEqual(received[1]?.input, [
      { text: 'USER:\nSecond turn', type: 'text' },
    ]);

    const third = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'A new conversation turn', role: 'user' }],
      }),
      headers: { 'X-Helm-Session': 'helm-session-1' },
      method: 'POST',
    });

    assert.equal(third.status, 200);
    assert.equal(received[2]?.threadId, 'thread-1');
    assert.deepEqual(received[2]?.input, [
      { text: 'USER:\nA new conversation turn', type: 'text' },
    ]);
  });

  it('rejects a repeated session turn and supports idempotent reset', async () => {
    let threadCount = 0;
    const sessions = new RelaySessionStore({ ttlMs: 60_000 });
    const app = makeApp(async (options) => {
      if (!options.threadId) {
        threadCount += 1;
        options.onThreadCreated?.(`thread-${threadCount}`);
      }
      options.onTurnStarted?.();
      return answer('answer');
    }, sessions);
    const body = JSON.stringify({
      messages: [{ content: 'One turn', role: 'user' }],
    });

    const first = await request(app, '/v1/chat/completions', {
      body,
      headers: { 'X-Helm-Session': 'helm-session-2' },
      method: 'POST',
    });
    const repeated = await request(app, '/v1/chat/completions', {
      body,
      headers: { 'X-Helm-Session': 'helm-session-2' },
      method: 'POST',
    });
    const deleted = await request(app, '/v1/helm/sessions/helm-session-2', {
      method: 'DELETE',
    });
    const deletedAgain = await request(
      app,
      '/v1/helm/sessions/helm-session-2',
      { method: 'DELETE' },
    );
    const afterReset = await request(app, '/v1/chat/completions', {
      body: JSON.stringify({
        messages: [{ content: 'New turn', role: 'user' }],
      }),
      headers: { 'X-Helm-Session': 'helm-session-2' },
      method: 'POST',
    });

    assert.equal(first.status, 200);
    assert.equal(repeated.status, 409);
    assert.deepEqual(await repeated.json(), {
      error: {
        message:
          'The Helm session request contains no new turn. Send a new message or reset the session before retrying.',
        type: 'session_error',
      },
    });
    assert.deepEqual(await deleted.json(), { deleted: true });
    assert.deepEqual(await deletedAgain.json(), { deleted: false });
    assert.equal(afterReset.status, 200);
    assert.equal(threadCount, 2);
  });
});
