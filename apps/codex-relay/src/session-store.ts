import type {
  RelayHistoryPart,
  RelayInputPart,
  RelayToolDefinition,
  RelayToolResult,
  RelayTurnResult,
} from './compat.ts';
import type { RunTurnOptions } from './relay.ts';

type SessionState = {
  activeTurns: number;
  developerInstructions?: string;
  deleted?: boolean;
  history: RelayHistoryPart[];
  lastActivityAt: number;
  model?: string;
  pendingTurn?: {
    toolCallIds: string[];
    turnId: string;
  };
  tail: Promise<void>;
  threadId?: string;
  tools?: RelayToolDefinition[];
  toolsConfigured: boolean;
};

type SessionStoreOptions = {
  clock?: () => number;
  onSessionRemoved?: (sessionId: string) => void;
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

const sameJson = (left: unknown, right: unknown): boolean => {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
};

const sameInputPart = (left: RelayInputPart, right: RelayInputPart): boolean =>
  left.type === right.type &&
  (left.type === 'text'
    ? right.type === 'text' && left.text === right.text
    : right.type === 'image' && left.url === right.url);

const sameHistoryPart = (
  left: RelayHistoryPart,
  right: RelayHistoryPart,
): boolean => {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === 'input' && right.kind === 'input') {
    return sameInputPart(left.part, right.part);
  }

  if (left.kind === 'tool-call' && right.kind === 'tool-call') {
    return (
      left.id === right.id &&
      left.name === right.name &&
      left.arguments === right.arguments
    );
  }

  return (
    left.kind === 'tool-result' &&
    right.kind === 'tool-result' &&
    left.id === right.id &&
    sameJson(left.content, right.content)
  );
};

const isPrefix = (
  prefix: RelayHistoryPart[],
  value: RelayHistoryPart[],
): boolean =>
  prefix.length <= value.length &&
  prefix.every((part, index) => {
    const candidate = value[index];
    return candidate ? sameHistoryPart(part, candidate) : false;
  });

const getIncrementalHistory = (
  previous: RelayHistoryPart[],
  current: RelayHistoryPart[],
): RelayHistoryPart[] => {
  if (previous.length === 0) {
    return current;
  }

  if (isPrefix(previous, current)) {
    return current.slice(previous.length);
  }

  if (current.length < previous.length && isPrefix(current, previous)) {
    return [];
  }

  // Some OpenAI-compatible clients send only the new user turn or only a
  // single tool result after the first request instead of replaying history.
  // Treat those short payloads as incremental, but never guess for a larger
  // ambiguous history.
  if (current.length > 0 && current.length <= 2) {
    return current;
  }

  throw new RelaySessionError(
    'The Helm session request does not extend the conversation already stored in the Codex thread. Reset the session before sending a different history.',
  );
};

const historyInput = (history: RelayHistoryPart[]): RelayInputPart[] =>
  history.flatMap((part) => (part.kind === 'input' ? [part.part] : []));

const sameTools = (
  left: RelayToolDefinition[] | undefined,
  right: RelayToolDefinition[] | undefined,
): boolean => sameJson(left ?? [], right ?? []);

const appendAssistantResult = (
  history: RelayHistoryPart[],
  result: RelayTurnResult,
): RelayHistoryPart[] => {
  const next = [...history];

  if (result.text.trim()) {
    next.push({
      kind: 'input',
      part: {
        text: `ASSISTANT:\n${result.text}`,
        type: 'text',
      },
    });
  }

  for (const call of result.toolCalls) {
    next.push({
      arguments: call.arguments,
      id: call.id,
      kind: 'tool-call',
      name: call.name,
    });
  }

  return next;
};

export class RelaySessionStore {
  private readonly clock: () => number;
  private readonly onSessionRemoved?: (sessionId: string) => void;
  private readonly sessions = new Map<string, SessionState>();
  private readonly ttlMs: number;
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor({
    clock = Date.now,
    onSessionRemoved,
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
    this.onSessionRemoved = onSessionRemoved;
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
    request: RunTurnOptions & {
      history: RelayHistoryPart[];
    },
    runTurn: (options: RunTurnOptions) => Promise<RelayTurnResult>,
  ): Promise<RelayTurnResult> {
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

      if (state.deleted) {
        throw new RelaySessionError(
          'The Helm session was deleted before this turn could start.',
        );
      }

      state.lastActivityAt = this.clock();

      if (state.toolsConfigured && !sameTools(state.tools, request.tools)) {
        throw new RelaySessionError(
          'The Helm session cannot change its tool definitions after the Codex thread starts. Reset the session before changing tools.',
        );
      }

      const incrementalHistory = getIncrementalHistory(
        state.history,
        request.history,
      );
      const incrementalInput = historyInput(incrementalHistory);
      const incrementalToolCallIds = new Set(
        incrementalHistory
          .filter((part) => part.kind === 'tool-result')
          .map((part) => part.id),
      );
      const toolResults = (request.toolResults ?? []).filter((result) =>
        incrementalToolCallIds.has(result.toolCallId),
      );
      const isContinuation = Boolean(state.pendingTurn);
      const isExistingThread = Boolean(state.threadId);
      const developerUpdate =
        isExistingThread &&
        !isContinuation &&
        request.developerInstructions !== undefined &&
        request.developerInstructions !== state.developerInstructions
          ? `DEVELOPER INSTRUCTIONS UPDATE:\n${request.developerInstructions?.trim() || '(none)'}`
          : undefined;

      if (isContinuation) {
        const pendingTurn = state.pendingTurn;
        if (!pendingTurn) {
          throw new RelaySessionError('The Codex session continuation is missing.');
        }

        const expected = new Set(pendingTurn.toolCallIds);
        const received = new Set(toolResults.map((result) => result.toolCallId));

        if (
          received.size !== expected.size ||
          received.size !== toolResults.length ||
          [...expected].some((id) => !received.has(id))
        ) {
          throw new RelaySessionError(
            'The Helm session must return one result for every pending Codex tool call before continuing.',
          );
        }
      } else if (toolResults.length > 0) {
        throw new RelaySessionError(
          'The Helm session supplied a tool result without an active Codex tool call.',
        );
      } else if (incrementalInput.length === 0 && !developerUpdate) {
        throw new RelaySessionError(
          'The Helm session request contains no new turn. Send a new message or reset the session before retrying.',
        );
      }

      const input = developerUpdate
        ? [{ text: developerUpdate, type: 'text' as const }, ...incrementalInput]
        : incrementalInput;
      const {
        continuationTurnId: ignoredContinuationTurnId,
        developerInstructions,
        history: ignoredHistory,
        onThreadCreated: callerOnThreadCreated,
        onTurnStarted: callerOnTurnStarted,
        threadId: ignoredThreadId,
        toolResults: ignoredToolResults,
        tools,
        ...rest
      } = request;
      void ignoredContinuationTurnId;
      void ignoredHistory;
      void ignoredThreadId;
      void ignoredToolResults;

      let turnStarted = false;
      const result = await runTurn({
        ...rest,
        ...(isContinuation
          ? {
              continuationTurnId: state.pendingTurn?.turnId,
              input: [],
              toolResults,
            }
          : {
              input,
              ...(!isExistingThread && developerInstructions !== undefined
                ? { developerInstructions }
                : {}),
            }),
        ...(isExistingThread ? { threadId: state.threadId } : {}),
        ...(state.model && state.model !== request.model
          ? { model: request.model }
          : {}),
        ...(isContinuation ? {} : { tools }),
        onThreadCreated: (threadId) => {
          state.threadId = threadId;
          state.lastActivityAt = this.clock();
          callerOnThreadCreated?.(threadId);
        },
        onTurnStarted: () => {
          turnStarted = true;
          state.lastActivityAt = this.clock();
          callerOnTurnStarted?.();
        },
        sessionId,
      });

      if (result.toolCalls.length > 0 && !result.turnId) {
        throw new RelaySessionError(
          'Codex returned a tool call without a continuation turn id.',
        );
      }

      if (!turnStarted && !isContinuation) {
        state.lastActivityAt = this.clock();
      }

      state.history = appendAssistantResult(request.history, result);
      state.pendingTurn =
        result.toolCalls.length > 0
          ? result.turnId
            ? {
                toolCallIds: result.toolCalls.map((call) => call.id),
                turnId: result.turnId,
              }
            : undefined
          : undefined;
      state.developerInstructions = request.developerInstructions;
      state.model = request.model;
      state.tools = request.tools;
      state.toolsConfigured = true;
      state.lastActivityAt = this.clock();
      return result;
    } finally {
      state.activeTurns -= 1;
      state.lastActivityAt = this.clock();
      release();
    }
  }

  delete(sessionId: string): boolean {
    return this.remove(sessionId);
  }

  expireInactive(now = this.clock()): number {
    let expired = 0;

    for (const [sessionId, state] of this.sessions) {
      if (
        state.activeTurns === 0 &&
        now - state.lastActivityAt >= this.ttlMs
      ) {
        if (this.remove(sessionId)) {
          expired += 1;
        }
      }
    }

    return expired;
  }

  close(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }

    for (const sessionId of this.sessions.keys()) {
      this.remove(sessionId);
    }
  }

  private remove(sessionId: string): boolean {
    const state = this.sessions.get(sessionId);

    if (!state) {
      return false;
    }

    state.deleted = true;
    this.sessions.delete(sessionId);

    this.onSessionRemoved?.(sessionId);
    return true;
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
      toolsConfigured: false,
    };
    this.sessions.set(sessionId, state);
    return state;
  }
}

export { getIncrementalHistory, historyInput };
