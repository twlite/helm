import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  RelayHistoryPart,
  RelayTurnResult,
} from './compat.ts';
import type { RunTurnOptions } from './relay.ts';
import { getIncrementalHistory, RelaySessionStore } from './session-store.ts';

type SessionTurnOptions = RunTurnOptions & { history: RelayHistoryPart[] };

const turn = (text: string): SessionTurnOptions => ({
  history: [
    {
      kind: 'input',
      part: { text: `USER:\n${text}`, type: 'text' },
    },
  ],
  input: [{ text: `USER:\n${text}`, type: 'text' }],
  model: 'codex',
});

describe('relay session store', () => {
  it('serializes turns for a session', async () => {
    const store = new RelaySessionStore({ ttlMs: 60_000 });
    let active = 0;
    let maximumActive = 0;
    let resolveFirst!: () => void;
    let resolveFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      resolveFirstStarted = resolve;
    });
    const firstFinished = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    let calls = 0;

    const runTurn = async (options: RunTurnOptions): Promise<RelayTurnResult> => {
      calls += 1;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (!options.threadId) {
        options.onThreadCreated?.('thread-serialized');
      }
      options.onTurnStarted?.();

      if (calls === 1) {
        resolveFirstStarted();
        await firstFinished;
      }

      active -= 1;
      return { text: `answer-${calls}`, toolCalls: [] };
    };

    const first = store.runTurn('session-1', turn('first'), runTurn);
    await firstStarted;
    const second = store.runTurn(
      'session-1',
      {
        ...turn('second'),
        history: [
          {
            kind: 'input',
            part: { text: 'USER:\nfirst', type: 'text' },
          },
          {
            kind: 'input',
            part: { text: 'USER:\nsecond', type: 'text' },
          },
        ],
        input: [
          { text: 'USER:\nfirst', type: 'text' },
          { text: 'USER:\nsecond', type: 'text' },
        ],
      },
      runTurn,
    );

    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(maximumActive, 1);

    resolveFirst();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.equal(active, 0);
    assert.equal(maximumActive, 1);
  });

  it('expires inactive sessions without expiring active turns', async () => {
    let now = 0;
    const removed: string[] = [];
    const store = new RelaySessionStore({
      clock: () => now,
      onSessionRemoved: (sessionId) => removed.push(sessionId),
      ttlMs: 100,
    });
    const runTurn = async (options: RunTurnOptions): Promise<RelayTurnResult> => {
      options.onThreadCreated?.('thread-expiring');
      options.onTurnStarted?.();
      return { text: 'answer', toolCalls: [] };
    };

    await store.runTurn('session-1', turn('first'), runTurn);
    assert.equal(store.size, 1);

    now = 99;
    assert.equal(store.expireInactive(), 0);
    now = 100;
    assert.equal(store.expireInactive(), 1);
    assert.equal(store.size, 0);
    assert.deepEqual(removed, ['session-1']);
  });

  it('allows screenshot pruning and normalized tool arguments', () => {
    const previous: RelayHistoryPart[] = [
      {
        kind: 'input',
        part: { text: 'USER:\nInspect the screen.', type: 'text' },
      },
      {
        arguments: '{}',
        id: 'call-screenshot-1',
        kind: 'tool-call',
        name: 'screenshot',
      },
      {
        content: [
          { text: 'Screenshot captured.', type: 'text' },
          { type: 'image', url: 'data:image/png;base64,AQ==' },
        ],
        id: 'call-screenshot-1',
        kind: 'tool-result',
      },
      {
        arguments: '{ "x": 1 }',
        id: 'call-screenshot-2',
        kind: 'tool-call',
        name: 'screenshot',
      },
    ];
    const current: RelayHistoryPart[] = [
      previous[0]!,
      previous[1]!,
      {
        content: [{ text: 'Screenshot captured.', type: 'text' }],
        id: 'call-screenshot-1',
        kind: 'tool-result',
      },
      {
        arguments: '{"x":1}',
        id: 'call-screenshot-2',
        kind: 'tool-call',
        name: 'screenshot',
      },
      {
        content: [{ text: 'Second screenshot captured.', type: 'text' }],
        id: 'call-screenshot-2',
        kind: 'tool-result',
      },
    ];

    assert.deepEqual(getIncrementalHistory(previous, current), [
      {
        content: [{ text: 'Second screenshot captured.', type: 'text' }],
        id: 'call-screenshot-2',
        kind: 'tool-result',
      },
    ]);
  });

  it('keeps a multi-step screenshot session aligned with provider-only context', async () => {
    const userInput: RelayHistoryPart = {
      kind: 'input',
      part: { text: 'USER:\nInspect the screen.', type: 'text' },
    };
    const firstCall: RelayHistoryPart = {
      arguments: '{}',
      id: 'call-screenshot-1',
      kind: 'tool-call',
      name: 'screenshot',
    };
    const firstResult: RelayHistoryPart = {
      content: [
        { text: 'Screenshot captured.', type: 'text' },
        { type: 'image', url: 'data:image/png;base64,AQ==' },
      ],
      id: 'call-screenshot-1',
      kind: 'tool-result',
    };
    const firstToolResult = {
      content: [
        { text: 'Screenshot captured.', type: 'text' as const },
        { type: 'image' as const, url: 'data:image/png;base64,AQ==' },
      ],
      toolCallId: 'call-screenshot-1',
    };
    const screenshotContext: RelayHistoryPart[] = [
      {
        kind: 'input',
        part: {
          text: 'USER:\nLatest desktop screenshot image for visual inspection. Use this image to read visible page text and UI state.',
          type: 'text',
        },
      },
      { kind: 'input', part: { type: 'image', url: 'data:image/png;base64,AQ==' } },
    ];
    const secondCall: RelayHistoryPart = {
      arguments: '{ "app": "firefox" }',
      id: 'call-open-firefox',
      kind: 'tool-call',
      name: 'open_application',
    };
    const secondResult: RelayHistoryPart = {
      content: [{ text: 'Firefox opened.', type: 'text' }],
      id: 'call-open-firefox',
      kind: 'tool-result',
    };
    const secondToolResult = {
      content: [{ text: 'Firefox opened.', type: 'text' as const }],
      toolCallId: 'call-open-firefox',
    };
    const store = new RelaySessionStore({ ttlMs: 60_000 });
    const received: RunTurnOptions[] = [];
    const runTurn = async (options: RunTurnOptions): Promise<RelayTurnResult> => {
      received.push(options);

      if (received.length === 1) {
        options.onThreadCreated?.('thread-multi-step');
        return {
          text: '',
          threadId: 'thread-multi-step',
          toolCalls: [
            { arguments: '{}', id: 'call-screenshot-1', name: 'screenshot' },
          ],
          turnId: 'turn-screenshot',
        };
      }

      if (received.length === 2) {
        return {
          text: '',
          threadId: 'thread-multi-step',
          toolCalls: [
            {
              arguments: '{"app":"firefox"}',
              id: 'call-open-firefox',
              name: 'open_application',
            },
          ],
          turnId: 'turn-open-firefox',
        };
      }

      return { text: 'The task can continue.', toolCalls: [] };
    };

    await store.runTurn(
      'session-multi-step',
      {
        history: [userInput],
        input: [{ text: 'USER:\nInspect the screen.', type: 'text' }],
        model: 'codex',
      },
      runTurn,
    );
    await store.runTurn(
      'session-multi-step',
      {
        history: [userInput, firstCall, firstResult, ...screenshotContext],
        input: [],
        model: 'codex',
        toolResults: [firstToolResult],
      },
      runTurn,
    );
    await store.runTurn(
      'session-multi-step',
      {
        history: [
          userInput,
          firstCall,
          {
            content: [{ text: 'Screenshot captured.', type: 'text' }],
            id: 'call-screenshot-1',
            kind: 'tool-result',
          },
          secondCall,
          secondResult,
          ...screenshotContext,
        ],
        input: [],
        model: 'codex',
        toolResults: [secondToolResult],
      },
      runTurn,
    );

    assert.equal(received.length, 3);
    assert.equal(received[1]?.continuationTurnId, 'turn-screenshot');
    assert.equal(received[2]?.continuationTurnId, 'turn-open-firefox');
  });
});
