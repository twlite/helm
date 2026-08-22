import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RunTurnOptions } from './relay.ts';
import { RelaySessionStore } from './session-store.ts';

const turn = (text: string): RunTurnOptions => ({
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

    const runTurn = async (options: RunTurnOptions) => {
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
      return `answer-${calls}`;
    };

    const first = store.runTurn('session-1', turn('first'), runTurn);
    await firstStarted;
    const second = store.runTurn(
      'session-1',
      {
        ...turn('second'),
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
    const store = new RelaySessionStore({
      clock: () => now,
      ttlMs: 100,
    });
    const runTurn = async (options: RunTurnOptions) => {
      options.onThreadCreated?.('thread-expiring');
      options.onTurnStarted?.();
      return 'answer';
    };

    await store.runTurn('session-1', turn('first'), runTurn);
    assert.equal(store.size, 1);

    now = 99;
    assert.equal(store.expireInactive(), 0);
    now = 100;
    assert.equal(store.expireInactive(), 1);
    assert.equal(store.size, 0);
  });
});
