import type { RelayInputPart } from './compat.ts';
import type { RunTurnOptions } from './relay.ts';

type SessionState = {
  activeTurns: number;
  developerInstructions?: string;
  history: RelayInputPart[];
  lastActivityAt: number;
  model?: string;
  tail: Promise<void>;
  threadId?: string;
};

type SessionStoreOptions = {
  clock?: () => number;
  sweepIntervalMs?: number;
  ttlMs: number;
};

export class RelaySessionError extends Error {
  readonly statusCode = 409 as const;

  constructor(message: string) {
    super(message);
    this.name = 'RelaySessionError';
  }
}

const sameInputPart = (left: RelayInputPart, right: RelayInputPart): boolean =>
  left.type === right.type &&
  (left.type === 'text'
    ? right.type === 'text' && left.text === right.text
    : right.type === 'image' && left.url === right.url);

const isPrefix = (
  prefix: RelayInputPart[],
  value: RelayInputPart[],
): boolean =>
  prefix.length <= value.length &&
  prefix.every((part, index) => sameInputPart(part, value[index] as RelayInputPart));

const getIncrementalInput = (
  previous: RelayInputPart[],
  current: RelayInputPart[],
): RelayInputPart[] => {
  if (previous.length === 0) {
    return current;
  }

  if (isPrefix(previous, current)) {
    return current.slice(previous.length);
  }

  // Some OpenAI-compatible clients send only the new user turn after the
  // first request instead of replaying their local message list. A short,
  // non-prefix payload is therefore already incremental and can be sent as
  // received. Larger non-prefix histories are ambiguous and are rejected so
  // we never guess by replaying an old turn.
  if (current.length > 0 && current.length <= 2) {
    return current;
  }

  throw new RelaySessionError(
    'The Helm session request does not extend the conversation already stored in the Codex thread. Reset the session before sending a different history.',
  );
};

export class RelaySessionStore {
  private readonly clock: () => number;
  private readonly sessions = new Map<string, SessionState>();
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor({
    clock = Date.now,
    sweepIntervalMs = 0,
    ttlMs,
  }: SessionStoreOptions) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error('Session TTL must be a positive integer.');
    }

    if (!Number.isSafeInteger(sweepIntervalMs) || sweepIntervalMs < 0) {
      throw new Error('Session sweep interval must be a non-negative integer.');
    }

    this.clock = clock;
    this.ttlMs = ttlMs;

    if (sweepIntervalMs > 0) {
      this.sweepTimer = setInterval(() => {
        this.expireInactive();
      }, sweepIntervalMs);
      this.sweepTimer.unref?.();
    }
  }

  get size(): number {
    return this.sessions.size;
  }

  async runTurn(
    sessionId: string,
    request: RunTurnOptions,
    runTurn: (options: RunTurnOptions) => Promise<string>,
  ): Promise<string> {
    const state = this.getOrCreate(sessionId);
    const previous = state.tail;
    let release!: () => void;

    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.activeTurns += 1;
    state.lastActivityAt = this.clock();

    try {
      await previous;

      state.lastActivityAt = this.clock();
      const incrementalInput = getIncrementalInput(state.history, request.input);
      const isExistingThread = Boolean(state.threadId);
      const developerUpdate =
        isExistingThread &&
        request.developerInstructions !== undefined &&
        request.developerInstructions !== state.developerInstructions
          ? `DEVELOPER INSTRUCTIONS UPDATE:\n${request.developerInstructions?.trim() || '(none)'}`
          : undefined;

      if (incrementalInput.length === 0 && !developerUpdate) {
        throw new RelaySessionError(
          'The Helm session request contains no new turn. Send a new message or reset the session before retrying.',
        );
      }

      const input = developerUpdate
        ? [{ text: developerUpdate, type: 'text' as const }, ...incrementalInput]
        : incrementalInput;
      const {
        developerInstructions,
        onThreadCreated: callerOnThreadCreated,
        onTurnStarted: callerOnTurnStarted,
        threadId: ignoredThreadId,
        ...rest
      } = request;
      void ignoredThreadId;

      let turnStarted = false;
      const markTurnStarted = () => {
        turnStarted = true;
        state.history = request.input;
        if (request.developerInstructions !== undefined) {
          state.developerInstructions = request.developerInstructions;
        }
        state.model = request.model;
        state.lastActivityAt = this.clock();
        callerOnTurnStarted?.();
      };

      const text = await runTurn({
        ...rest,
        input,
        ...(isExistingThread
          ? { threadId: state.threadId }
          : developerInstructions !== undefined
            ? { developerInstructions }
            : {}),
        ...(state.model && state.model !== request.model
          ? { model: request.model }
          : {}),
        onThreadCreated: (threadId) => {
          state.threadId = threadId;
          state.lastActivityAt = this.clock();
          callerOnThreadCreated?.(threadId);
        },
        onTurnStarted: markTurnStarted,
      });

      if (!turnStarted) {
        markTurnStarted();
      }

      state.lastActivityAt = this.clock();
      return text;
    } finally {
      state.activeTurns -= 1;
      state.lastActivityAt = this.clock();
      release();
    }
  }

  delete(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  expireInactive(now = this.clock()): number {
    let expired = 0;

    for (const [sessionId, state] of this.sessions) {
      if (
        state.activeTurns === 0 &&
        now - state.lastActivityAt >= this.ttlMs
      ) {
        this.sessions.delete(sessionId);
        expired += 1;
      }
    }

    return expired;
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    this.sessions.clear();
  }

  private getOrCreate(sessionId: string): SessionState {
    if (!sessionId) {
      throw new RelaySessionError('X-Helm-Session must not be empty.');
    }

    this.expireInactive();

    const existing = this.sessions.get(sessionId);
    if (existing) {
      return existing;
    }

    const state: SessionState = {
      activeTurns: 0,
      history: [],
      lastActivityAt: this.clock(),
      tail: Promise.resolve(),
    };
    this.sessions.set(sessionId, state);
    return state;
  }
}

export { getIncrementalInput };
