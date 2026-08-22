import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { once } from 'node:events';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { config } from './config.ts';
import type {
  RelayInputPart,
  RelayToolCall,
  RelayToolDefinition,
  RelayToolResult,
  RelayTurnResult,
} from './compat.ts';

type RpcId = number | string;
type RpcParams = Record<string, unknown>;

export type RpcMessage = {
  error?: {
    code: number;
    data?: unknown;
    message: string;
  };
  id?: RpcId;
  jsonrpc?: '2.0';
  method?: string;
  params?: RpcParams;
  result?: unknown;
};

export type RunTurnOptions = {
  continuationTurnId?: string;
  developerInstructions?: string;
  input: RelayInputPart[];
  model?: string;
  onDelta?: (delta: string) => void | Promise<void>;
  onThreadCreated?: (threadId: string) => void;
  onTurnStarted?: () => void;
  sessionId?: string;
  signal?: AbortSignal;
  threadId?: string;
  toolResults?: RelayToolResult[];
  tools?: RelayToolDefinition[];
};

type PendingRequest = {
  cleanup: () => void;
  reject: (error: Error) => void;
  resolve: (result: unknown) => void;
};

type ThreadStartResult = {
  thread?: {
    id?: string;
  };
};

type TurnStartResult = {
  turn?: {
    id?: string;
  };
};

type DynamicToolCallParams = {
  arguments: unknown;
  callId: string;
  namespace: string | null;
  threadId: string;
  tool: string;
  turnId: string;
};

type PendingDynamicToolCall = {
  call: RelayToolCall;
  requestId: RpcId;
};

type TurnWaiter = {
  cleanup: () => void;
  onDelta?: (delta: string) => void | Promise<void>;
  reject: (error: Error) => void;
  resolve: (result: RelayTurnResult) => void;
};

type ActiveTurn = {
  completed?: RelayTurnResult;
  pendingCalls: Map<string, PendingDynamicToolCall>;
  sessionId?: string;
  text: string;
  threadId: string;
  toolCallTimer?: ReturnType<typeof setImmediate>;
  turnId: string;
  waiter?: TurnWaiter;
};

const HELM_CODEX_DEVELOPER_INSTRUCTIONS = `You are the reasoning and vision model for Helm.

You do not directly interact with the host computer.

All computer interaction is performed exclusively through tools supplied by Helm. Helm-provided tools appear in your callable tool list; use their exact names and JSON schemas. When screen information is required, call Helm's screenshot tool before answering. When an action is required, call the appropriate Helm tool.

Never attempt to inspect or manipulate the host machine using shell commands, filesystem access, browser tools, plugins, apps, subagents, or built-in computer-use capabilities.

If Helm has not supplied the appropriate computer-use tool, say that you cannot inspect or change the screen. Do not try to compensate with a host-side capability.`;

// These are the feature names exposed by codex-cli 0.149.0. They are sent
// through thread/start.config so the model receives no host-side tools in the
// first place; the read-only sandbox remains a second line of defense.
const HELM_DISABLED_FEATURES = {
  apps: false,
  auth_elicitation: false,
  browser_use: false,
  browser_use_external: false,
  browser_use_full_cdp_access: false,
  code_mode: false,
  code_mode_host: false,
  code_mode_only: false,
  computer_use: false,
  enable_mcp_apps: false,
  goals: false,
  guardian_approval: false,
  hooks: false,
  image_generation: false,
  in_app_browser: false,
  in_app_chat: false,
  in_app_dictation: false,
  in_app_updates: false,
  memories: false,
  multi_agent: false,
  multi_agent_v2: false,
  mentions_v2: false,
  network_proxy: false,
  plugins: false,
  plugin_sharing: false,
  recommended_plugins: false,
  remote_plugin: false,
  search_tool: false,
  shell_snapshot: false,
  shell_tool: false,
  skill_mcp_dependency_install: false,
  skill_search: false,
  standalone_web_search: false,
  tool_call_mcp_elicitation: false,
  tool_suggest: false,
  unified_exec: false,
  unified_exec_zsh_fork: false,
  view_image: false,
  web_search_request: false,
  workspace_dependencies: false,
};

const HELM_THREAD_CONFIG = {
  features: HELM_DISABLED_FEATURES,
  web_search: 'disabled',
};

const HELM_MODEL_CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'codex-model-catalog.json',
);

const HELM_APP_SERVER_CONFIG_ARGS = [
  // Do not inherit user-configured MCP servers, plugins, or external turn
  // notifications from the Codex home directory.
  '-c',
  'mcp_servers={}',
  '-c',
  'plugins={}',
  '-c',
  'notify=[]',
  '-c',
  `model_catalog_json=${HELM_MODEL_CATALOG_PATH}`,
];

const HELM_APP_SERVER_FEATURE_ARGS = Object.keys(HELM_DISABLED_FEATURES).flatMap(
  (feature) => ['--disable', feature],
);

const createAbortError = (): Error => {
  const error = new Error('The relay request was aborted.');
  error.name = 'AbortError';
  return error;
};

const errorFromUnknown = (value: unknown, fallback: string): Error =>
  value instanceof Error ? value : new Error(fallback);

const getTurnId = (message: RpcMessage): string | undefined => {
  const direct = message.params?.turnId;

  if (typeof direct === 'string') {
    return direct;
  }

  const turn = message.params?.turn;

  if (
    turn &&
    typeof turn === 'object' &&
    !Array.isArray(turn) &&
    typeof (turn as { id?: unknown }).id === 'string'
  ) {
    return (turn as { id: string }).id;
  }

  return undefined;
};

const getThreadId = (message: RpcMessage): string | undefined => {
  const direct = message.params?.threadId;

  if (typeof direct === 'string') {
    return direct;
  }

  const turn = message.params?.turn;

  if (
    turn &&
    typeof turn === 'object' &&
    !Array.isArray(turn) &&
    typeof (turn as { threadId?: unknown }).threadId === 'string'
  ) {
    return (turn as { threadId: string }).threadId;
  }

  return undefined;
};

const asDynamicToolCallParams = (
  message: RpcMessage,
): DynamicToolCallParams | undefined => {
  const params = message.params;

  if (!params) {
    return undefined;
  }

  if (
    typeof params.threadId !== 'string' ||
    typeof params.turnId !== 'string' ||
    typeof params.callId !== 'string' ||
    typeof params.tool !== 'string'
  ) {
    return undefined;
  }

  return {
    arguments: params.arguments,
    callId: params.callId,
    namespace: typeof params.namespace === 'string' ? params.namespace : null,
    threadId: params.threadId,
    tool: params.tool,
    turnId: params.turnId,
  };
};

const stringifyArguments = (value: unknown): string => {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
};

const toDynamicTools = (tools: RelayToolDefinition[] | undefined) =>
  tools?.map((tool) => ({
    deferLoading: false,
    description: tool.description,
    inputSchema: tool.inputSchema,
    name: tool.name,
    type: 'function' as const,
  }));

const toDynamicToolResponse = (toolResult: RelayToolResult) => ({
  contentItems: toolResult.content.map((part) =>
    part.type === 'image'
      ? { imageUrl: part.url, type: 'inputImage' as const }
      : { text: part.text, type: 'inputText' as const },
  ),
  success: true,
});

export class CodexAppServer {
  private readonly debug: boolean;
  private readonly isolatedCodexHome: string;
  private readonly isolatedCwd: string;
  private readonly model: string | undefined;
  private readonly process: ChildProcessByStdio<Writable, Readable, null>;
  private readonly activeTurns = new Map<string, ActiveTurn>();
  private readonly pendingToolCalls = new Map<
    string,
    { active: ActiveTurn; pending: PendingDynamicToolCall }
  >();
  private readonly turnBuffers = new Map<string, RpcMessage[]>();
  private readonly pending = new Map<number, PendingRequest>();
  private failure: Error | undefined;
  private initializePromise: Promise<void> | undefined;
  private nextId = 1;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    options: { bin?: string; debug?: boolean; model?: string } = {},
  ) {
    this.isolatedCodexHome = mkdtempSync(join(tmpdir(), 'helm-codex-home-'));
    this.debug = options.debug ?? config.debug;
    this.isolatedCwd = mkdtempSync(join(tmpdir(), 'helm-codex-relay-'));
    this.model = options.model ?? config.codexModel;

    const sourceCodexHome =
      process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');

    try {
      // Auth is the only user Codex state the relay needs. Keeping it in a
      // temporary home prevents config.toml, MCP servers, plugins, hooks, and
      // notifications from crossing into the Helm process.
      copyFileSync(
        join(sourceCodexHome, 'auth.json'),
        join(this.isolatedCodexHome, 'auth.json'),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn('Could not copy Codex auth into the isolated relay home.', error);
      }
    }

    this.process = spawn(
      options.bin ?? config.codexBin,
      [
        'app-server',
        ...HELM_APP_SERVER_FEATURE_ARGS,
        ...HELM_APP_SERVER_CONFIG_ARGS,
        '--listen',
        'stdio://',
      ],
      {
        cwd: this.isolatedCwd,
        env: {
          ...process.env,
          CODEX_HOME: this.isolatedCodexHome,
        },
        stdio: ['pipe', 'pipe', 'inherit'],
        windowsHide: true,
      },
    );

    const lines = createInterface({ input: this.process.stdout });

    lines.on('line', (line) => {
      if (!line.trim()) {
        return;
      }

      try {
        this.handleMessage(JSON.parse(line) as RpcMessage);
      } catch (error) {
        console.error('Invalid Codex app-server message.', error);
      }
    });

    this.process.on('error', (error) => {
      this.fail(errorFromUnknown(error, 'Codex app-server failed to start.'));
    });

    this.process.stdin.on('error', (error) => {
      this.fail(errorFromUnknown(error, 'Codex app-server stdin failed.'));
    });

    this.process.on('exit', (code, signal) => {
      this.fail(
        new Error(
          signal
            ? `Codex app-server exited with signal ${signal}.`
            : `Codex app-server exited with code ${code ?? 'unknown'}.`,
        ),
      );
    });
  }

  private fail(error: Error) {
    if (this.failure) {
      return;
    }

    this.failure = error;

    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }

    this.pending.clear();

    for (const active of this.activeTurns.values()) {
      active.waiter?.cleanup();
      active.waiter?.reject(error);
      active.waiter = undefined;
    }

    this.activeTurns.clear();
    this.pendingToolCalls.clear();
    this.turnBuffers.clear();
  }

  private logEvent(message: RpcMessage, active?: ActiveTurn) {
    if (!this.debug || !message.method) {
      return;
    }

    const turnId = getTurnId(message) ?? active?.turnId;
    const threadId = getThreadId(message) ?? active?.threadId;
    console.debug('[codex-relay] Codex event', {
      event: message.method,
      sessionId: active?.sessionId ?? 'stateless',
      threadId,
      turnId,
    });
  }

  private send(message: RpcMessage): Promise<void> {
    const line = `${JSON.stringify(message)}\n`;
    const write = this.writeQueue.then(async () => {
      if (this.failure) {
        throw this.failure;
      }

      if (!this.process.stdin.writable) {
        throw new Error('Codex app-server stdin is not writable.');
      }

      if (!this.process.stdin.write(line)) {
        await once(this.process.stdin, 'drain');
      }
    });

    this.writeQueue = write.catch(() => undefined);
    return write;
  }

  private sendUnsupportedRequest(message: RpcMessage) {
    if (message.id === undefined) {
      return;
    }

    void this.send({
      error: {
        code: -32601,
        message: `Unsupported app-server request: ${message.method ?? 'unknown'}`,
      },
      id: message.id,
      jsonrpc: '2.0',
    }).catch((error: unknown) => {
      this.fail(errorFromUnknown(error, 'Could not answer app-server request.'));
    });
  }

  private handleMessage(message: RpcMessage) {
    const isResponse =
      message.id !== undefined &&
      !message.method &&
      ('result' in message || 'error' in message);

    if (isResponse) {
      const request =
        typeof message.id === 'number' ? this.pending.get(message.id) : undefined;

      if (!request) {
        return;
      }

      this.pending.delete(message.id as number);
      request.cleanup();

      if (message.error) {
        request.reject(
          new Error(
            `Codex RPC ${message.error.code}: ${message.error.message}`,
          ),
        );
      } else {
        request.resolve(message.result);
      }

      return;
    }

    const turnId = getTurnId(message);
    const active = turnId ? this.activeTurns.get(turnId) : undefined;
    this.logEvent(message, active);

    if (message.method && message.id !== undefined) {
      if (message.method === 'item/tool/call') {
        if (active) {
          this.handleDynamicToolCall(message, active);
        } else if (turnId) {
          this.bufferTurnMessage(turnId, message);
        } else {
          this.sendUnsupportedRequest(message);
        }
        return;
      }

      this.sendUnsupportedRequest(message);
      return;
    }

    if (!turnId) {
      return;
    }

    if (active) {
      this.consumeTurnEvent(active, message);
      return;
    }

    this.bufferTurnMessage(turnId, message);
  }

  private bufferTurnMessage(turnId: string, message: RpcMessage) {
    const buffer = this.turnBuffers.get(turnId) ?? [];

    if (buffer.length < 512) {
      buffer.push(message);
      this.turnBuffers.set(turnId, buffer);
    }
  }

  call<T = unknown>(
    method: string,
    params?: RpcParams,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure);
    }

    if (signal?.aborted) {
      return Promise.reject(createAbortError());
    }

    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        const request = this.pending.get(id);

        if (!request) {
          return;
        }

        this.pending.delete(id);
        request.cleanup();
        reject(createAbortError());
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      this.pending.set(id, {
        cleanup,
        reject,
        resolve: (result) => resolve(result as T),
      });

      signal?.addEventListener('abort', onAbort, { once: true });

      void this.send({
        jsonrpc: '2.0',
        id,
        method,
        ...(params !== undefined ? { params } : {}),
      }).catch((error: unknown) => {
        const request = this.pending.get(id);

        if (!request) {
          return;
        }

        this.pending.delete(id);
        request.cleanup();
        reject(errorFromUnknown(error, `Codex RPC ${method} failed.`));
      });
    });
  }

  notify(method: string, params?: RpcParams) {
    void this.send({
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }).catch((error: unknown) => {
      this.fail(errorFromUnknown(error, `Codex notification ${method} failed.`));
    });
  }

  async initialize() {
    this.initializePromise ??= this.initializeOnce();
    return this.initializePromise;
  }

  private async initializeOnce() {
    await this.call('initialize', {
      capabilities: {
        // dynamicTools is currently part of the app-server experimental API.
        // Helm opts into that API only to receive Helm-owned tool calls.
        experimentalApi: true,
      },
      clientInfo: {
        name: 'helm-openai-relay',
        title: 'Helm OpenAI Relay',
        version: '0.1.0',
      },
    });

    this.notify('initialized');

    const account = await this.call<{
      account?: {
        planType?: string;
        type?: string;
      };
    }>('account/read', { refreshToken: false });

    console.log(
      'Codex account:',
      account.account?.type ?? 'none',
      account.account?.planType ?? '',
    );
  }

  async runTurn(options: RunTurnOptions): Promise<RelayTurnResult> {
    if (options.signal?.aborted) {
      throw createAbortError();
    }

    if (options.toolResults && options.toolResults.length > 0) {
      return this.continueTurn(options);
    }

    if (options.continuationTurnId) {
      throw new Error('A continuation turn requires tool results.');
    }

    let activeThreadId = options.threadId;

    if (!activeThreadId) {
      const effectiveModel = options.model ?? this.model;
      const developerInstructions = [
        options.developerInstructions?.trim(),
        HELM_CODEX_DEVELOPER_INSTRUCTIONS,
      ]
        .filter(Boolean)
        .join('\n\n');
      const thread = await this.call<ThreadStartResult>(
        'thread/start',
        {
          approvalPolicy: 'never',
          config: HELM_THREAD_CONFIG,
          cwd: this.isolatedCwd,
          developerInstructions,
          ephemeral: true,
          ...(effectiveModel ? { model: effectiveModel } : {}),
          dynamicTools: toDynamicTools(options.tools),
          sandbox: 'read-only',
        },
        options.signal,
      );

      activeThreadId = thread.thread?.id;

      if (!activeThreadId) {
        throw new Error('Codex did not return a thread id.');
      }

      options.onThreadCreated?.(activeThreadId);
    }

    const started = await this.call<TurnStartResult>(
      'turn/start',
      {
        input: options.input,
        ...(options.model ? { model: options.model } : {}),
        threadId: activeThreadId,
      },
      options.signal,
    );

    const turnId = started.turn?.id;

    if (!turnId) {
      throw new Error('Codex did not return a turn id.');
    }

    options.onTurnStarted?.();

    const active: ActiveTurn = {
      pendingCalls: new Map(),
      sessionId: options.sessionId,
      text: '',
      threadId: activeThreadId,
      turnId,
    };
    this.activeTurns.set(turnId, active);

    return this.waitForTurn(active, options);
  }

  cancelSession(sessionId: string) {
    for (const active of [...this.activeTurns.values()]) {
      if (active.sessionId === sessionId) {
        this.interruptTurn(active);
      }
    }
  }

  private async continueTurn(options: RunTurnOptions): Promise<RelayTurnResult> {
    const toolResults = options.toolResults ?? [];
    const first = this.pendingToolCalls.get(toolResults[0]?.toolCallId);
    const active = first?.active;

    if (!active) {
      throw new Error(
        'The relay could not find the active Codex turn for the supplied tool result.',
      );
    }

    if (
      options.continuationTurnId &&
      options.continuationTurnId !== active.turnId
    ) {
      throw new Error('The tool result belongs to a different Codex turn.');
    }

    if (active.pendingCalls.size !== toolResults.length) {
      throw new Error(
        'The relay requires one tool result for every pending Codex tool call.',
      );
    }

    const pending = toolResults.map((toolResult) => {
      const entry = this.pendingToolCalls.get(toolResult.toolCallId);

      if (!entry || entry.active !== active) {
        throw new Error(
          `The relay could not match tool result ${toolResult.toolCallId} to Codex.`,
        );
      }

      return { entry, toolResult };
    });

    active.text = '';
    const resultPromise = this.waitForTurn(active, options);

    try {
      for (const { entry, toolResult } of pending) {
        this.pendingToolCalls.delete(toolResult.toolCallId);
        active.pendingCalls.delete(toolResult.toolCallId);
        await this.send({
          id: entry.pending.requestId,
          jsonrpc: '2.0',
          result: toDynamicToolResponse(toolResult),
        });
      }
    } catch (error) {
      this.rejectWaiter(
        active,
        errorFromUnknown(error, 'Could not resume the Codex turn.'),
      );
      await resultPromise.catch(() => undefined);
      throw error;
    }

    return resultPromise;
  }

  private handleDynamicToolCall(message: RpcMessage, active: ActiveTurn) {
    const params = asDynamicToolCallParams(message);

    if (!params || message.id === undefined) {
      this.sendUnsupportedRequest(message);
      return;
    }

    let openAiCallId = params.callId;

    if (this.pendingToolCalls.has(openAiCallId)) {
      openAiCallId = `${params.callId}-${randomUUID()}`;
    }

    const call: RelayToolCall = {
      arguments: stringifyArguments(params.arguments),
      id: openAiCallId,
      name: params.tool,
      ...(params.namespace ? { namespace: params.namespace } : {}),
    };
    const pending: PendingDynamicToolCall = {
      call,
      requestId: message.id,
    };

    active.pendingCalls.set(openAiCallId, pending);
    this.pendingToolCalls.set(openAiCallId, { active, pending });

    if (this.debug) {
      console.debug('[codex-relay] Codex dynamic tool requested', {
        sessionId: active.sessionId ?? 'stateless',
        threadId: active.threadId,
        tool: params.tool,
        turnId: active.turnId,
      });
    }

    if (active.toolCallTimer) {
      return;
    }

    active.toolCallTimer = setImmediate(() => {
      active.toolCallTimer = undefined;

      if (!active.waiter || active.pendingCalls.size === 0) {
        return;
      }

      this.resolveWaiter(active, {
        text: active.text,
        threadId: active.threadId,
        toolCalls: [...active.pendingCalls.values()].map(({ call: item }) => item),
        turnId: active.turnId,
      });
    });
  }

  private consumeTurnEvent(active: ActiveTurn, message: RpcMessage) {
    if (message.method === 'item/agentMessage/delta') {
      const delta = message.params?.delta;

      if (typeof delta !== 'string') {
        return;
      }

      active.text += delta;

      try {
        const callback = active.waiter?.onDelta?.(delta);

        if (callback) {
          void callback.catch((error: unknown) => {
            this.rejectWaiter(
              active,
              errorFromUnknown(error, 'Relay delta handler failed.'),
            );
          });
        }
      } catch (error) {
        this.rejectWaiter(
          active,
          errorFromUnknown(error, 'Relay delta handler failed.'),
        );
      }

      return;
    }

    if (message.method !== 'turn/completed') {
      return;
    }

    const turn = message.params?.turn;
    const turnStatus =
      turn &&
      typeof turn === 'object' &&
      !Array.isArray(turn) &&
      typeof (turn as { status?: unknown }).status === 'string'
        ? (turn as { status: string }).status
        : undefined;

    if (turnStatus === 'failed') {
      const error = new Error(
        turn &&
          typeof turn === 'object' &&
          !Array.isArray(turn) &&
          typeof (turn as { error?: { message?: unknown } }).error?.message ===
            'string'
          ? (turn as { error: { message: string } }).error.message
          : 'Codex turn failed.',
      );
      this.rejectWaiter(active, error);
      return;
    }

    if (turnStatus === 'interrupted') {
      this.rejectWaiter(active, new Error('Codex turn was interrupted.'));
      return;
    }

    this.resolveWaiter(active, {
      text: active.text,
      threadId: active.threadId,
      toolCalls: [],
      turnId: active.turnId,
    });
  }

  private flushTurnBuffer(active: ActiveTurn) {
    const buffered = this.turnBuffers.get(active.turnId);

    if (!buffered) {
      return;
    }

    this.turnBuffers.delete(active.turnId);

    for (const message of buffered) {
      if (!this.activeTurns.has(active.turnId)) {
        return;
      }

      if (message.method === 'item/tool/call' && message.id !== undefined) {
        this.handleDynamicToolCall(message, active);
      } else {
        this.consumeTurnEvent(active, message);
      }
    }
  }

  private waitForTurn(
    active: ActiveTurn,
    options: Pick<
      RunTurnOptions,
      'onDelta' | 'signal' | 'sessionId'
    >,
  ): Promise<RelayTurnResult> {
    if (active.completed) {
      const completed = active.completed;
      this.cleanupTurn(active);
      return Promise.resolve(completed);
    }

    if (active.waiter) {
      return Promise.reject(new Error('The Codex turn already has an active waiter.'));
    }

    active.sessionId ??= options.sessionId;

    return new Promise<RelayTurnResult>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        options.signal?.removeEventListener('abort', onAbort);
      };

      const settle = (callback: () => void) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        callback();
      };

      const onAbort = () => {
        settle(() => {
          active.waiter = undefined;
          this.interruptTurn(active);
          reject(createAbortError());
        });
      };

      active.waiter = {
        cleanup,
        onDelta: options.onDelta,
        reject: (error) => settle(() => reject(error)),
        resolve: (result) => settle(() => resolve(result)),
      };

      options.signal?.addEventListener('abort', onAbort, { once: true });

      this.flushTurnBuffer(active);

      if (active.pendingCalls.size > 0 && !active.toolCallTimer) {
        active.toolCallTimer = setImmediate(() => {
          active.toolCallTimer = undefined;

          if (active.waiter && active.pendingCalls.size > 0) {
            this.resolveWaiter(active, {
              text: active.text,
              threadId: active.threadId,
              toolCalls: [...active.pendingCalls.values()].map(
                ({ call }) => call,
              ),
              turnId: active.turnId,
            });
          }
        });
      }

      if (options.signal?.aborted) {
        onAbort();
      }
    });
  }

  private resolveWaiter(active: ActiveTurn, result: RelayTurnResult) {
    const waiter = active.waiter;

    if (!waiter) {
      active.completed = result;
      return;
    }

    active.waiter = undefined;
    waiter.cleanup();
    waiter.resolve(result);

    if (result.toolCalls.length === 0) {
      this.cleanupTurn(active);
    }
  }

  private rejectWaiter(active: ActiveTurn, error: Error) {
    const waiter = active.waiter;

    if (!waiter) {
      active.completed = undefined;
      this.cleanupTurn(active);
      return;
    }

    active.waiter = undefined;
    waiter.cleanup();
    waiter.reject(error);
    this.cleanupTurn(active);
  }

  private interruptTurn(active: ActiveTurn) {
    void this.call('turn/interrupt', {
      threadId: active.threadId,
      turnId: active.turnId,
    }).catch(() => {
      // The request is already being aborted; Codex may have completed first.
    });
    this.cleanupTurn(active);
  }

  private cleanupTurn(active: ActiveTurn) {
    if (active.toolCallTimer) {
      clearImmediate(active.toolCallTimer);
      active.toolCallTimer = undefined;
    }

    for (const callId of active.pendingCalls.keys()) {
      this.pendingToolCalls.delete(callId);
    }

    active.pendingCalls.clear();
    this.activeTurns.delete(active.turnId);
    this.turnBuffers.delete(active.turnId);
  }

  close() {
    this.fail(new Error('Codex app-server is shutting down.'));

    if (!this.process.killed && this.process.exitCode === null) {
      this.process.kill('SIGTERM');
    }

    try {
      rmSync(this.isolatedCwd, { force: true, recursive: true });
      rmSync(this.isolatedCodexHome, { force: true, recursive: true });
    } catch {
      // The process is already shutting down; stale temporary relay state is safe.
    }
  }
}
