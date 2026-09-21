import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type {
  JsonValue,
  MessageRole,
  Run,
  RunStep,
  ToolResult,
  WebSocketEvent,
} from '@helm/shared';
import { MockGuestTransport } from './tools/mock-guest-transport';
import { createGuestToolRegistry } from './tools/guest-tools';
import { CriterionVerifierRegistry } from './tools/criterion-verifier';
import { AgentRuntime, createScriptedDemoDecisions, createScriptedDemoTask, ScriptedDecisionProvider, ScriptedTaskPlanner } from './agent';
import type { RuntimeEvent, RuntimeEventSink, RuntimeRepository } from './agent';
import { PersistenceDatabase } from './db/database';
import type { CreateMemoryInput } from './memory/repository';
import { MemoryService } from './memory/service';
import { EventHub, type EventSocket } from './events';
import { loadConfig, type HelmConfig } from './config';
import { logger } from './logger';
import { HttpGuestTransport } from './vm/transport';
import { VmController } from './vm/vm-controller';

const messageInputSchema = z.object({
  role: z.enum(['user', 'assistant', 'system', 'tool']).default('user'),
  content: z.string().min(1).max(200_000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const threadInputSchema = z.object({ title: z.string().trim().min(1).max(200) });
const memoryInputSchema = z.object({
  content: z.string().trim().min(1).max(100_000),
  kind: z.enum(['fact', 'preference', 'instruction', 'note']).default('note'),
  importance: z.number().min(0).max(1).default(0.5),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const scriptedDemoInputSchema = z.object({ threadId: z.string().min(1).optional() });

function jsonValue(value: unknown): JsonValue {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return JSON.parse(encoded) as JsonValue;
  } catch {
    return String(value);
  }
}

function jsonObject(value: unknown): Record<string, JsonValue> {
  const normalized = jsonValue(value);
  return typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
    ? normalized
    : {};
}

function jsonResponse(body: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      ...headers,
    },
  });
}

function errorResponse(code: string, message: string, status = 400, details?: unknown): Response {
  return jsonResponse({ error: { code, message, ...(details === undefined ? {} : { details }) } }, status);
}

function notFound(message = 'The requested resource was not found.'): Response {
  return errorResponse('NOT_FOUND', message, 404);
}

function pathSegments(pathname: string): string[] {
  return pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
}

function isErrorWithCode(error: unknown): error is { code: string; message: string; details?: unknown } {
  return typeof error === 'object' && error !== null && 'code' in error && 'message' in error;
}

function errorDetails(error: unknown): { code: string; message: string; details?: unknown } {
  if (isErrorWithCode(error)) return { code: String(error.code), message: String(error.message), details: error.details };
  if (error instanceof z.ZodError) return { code: 'INVALID_INPUT', message: 'The request body is invalid.', details: error.issues };
  if (error instanceof Error) return { code: 'INTERNAL_ERROR', message: error.message };
  return { code: 'INTERNAL_ERROR', message: String(error) };
}

async function parseBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiFailure('INVALID_JSON', 'Request body must be valid JSON.', 400);
  }
}

class ApiFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}

class RuntimeDatabaseAdapter implements RuntimeRepository {
  constructor(private readonly database: PersistenceDatabase) {}

  saveRun(run: Run): void {
    const current = this.database.runs.getById(run.id);
    if (!current) {
      this.database.runs.create({
        id: run.id,
        threadId: run.threadId,
        sourceMessageId: run.sourceMessageId,
        goal: run.goal,
        criteria: run.criteria,
        status: run.status,
        error: run.error,
        createdAt: run.createdAt,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
      });
      return;
    }

    if (current.status !== run.status) {
      this.database.runs.transition(run.id, run.status, run.error);
    } else if (run.error && !current.error) {
      this.database.runs.update(run.id, { error: run.error });
    }
    this.database.runs.update(run.id, {
      goal: run.goal,
      criteria: run.criteria,
      sourceMessageId: run.sourceMessageId,
      error: run.error ?? null,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
    });
  }

  saveStep(step: RunStep): void {
    if (this.database.runSteps.getById(step.id)) {
      this.database.runSteps.update(step.id, {
        phase: step.phase,
        decision: step.decision,
        toolName: step.toolName,
        toolInput: step.toolInput,
        toolResult: step.toolResult,
        observation: step.observation,
        verification: step.verification,
        completedAt: step.completedAt,
      });
      return;
    }
    this.database.runSteps.create({
      id: step.id,
      runId: step.runId,
      stepIndex: step.stepIndex,
      phase: step.phase,
      decision: step.decision,
      toolName: step.toolName,
      toolInput: step.toolInput,
      toolResult: step.toolResult,
      observation: step.observation,
      verification: step.verification,
      createdAt: step.createdAt,
      completedAt: step.completedAt,
    });
  }
}

class RuntimeEvents implements RuntimeEventSink {
  constructor(private readonly events: EventHub) {}

  emit(event: RuntimeEvent): void {
    const type = event.type === 'run.blocked' ? 'run.failed' : event.type;
    this.events.publish(type as WebSocketEvent['type'], jsonValue(event.payload), { runId: event.runId });
  }
}

export interface HelmApplication {
  readonly config: HelmConfig;
  readonly database: PersistenceDatabase;
  readonly memory: MemoryService;
  readonly events: EventHub;
  readonly vm: VmController;
  handle(request: Request, server?: { upgrade(request: Request, options?: unknown): boolean }): Promise<Response | undefined>;
  close(): Promise<void>;
}

export function createHelmApplication(config: HelmConfig = loadConfig()): HelmApplication {
  mkdirSync(config.dataDir, { recursive: true });
  mkdirSync(config.runtimeDir, { recursive: true });
  const database = new PersistenceDatabase(config.databasePath);
  const memory = new MemoryService(database.sqlite);
  const events = new EventHub();
  const envelopeGuest = new HttpGuestTransport({
    baseUrl: `http://${config.guestHost}:${config.guestPort}`,
    timeoutMs: config.toolTimeoutMs,
  });
  const vm = new VmController(config, events, envelopeGuest);
  const activeRuns = new Map<string, { runtime: AgentRuntime; cancellation: AbortController }>();
  const runAdapter = new RuntimeDatabaseAdapter(database);
  const runtimeEvents = new RuntimeEvents(events);

  const runScriptedDemo = async (threadId: string, sourceMessageId?: string): Promise<Run> => {
    const guest = new MockGuestTransport();
    const task = createScriptedDemoTask(threadId);
    const provider = new ScriptedDecisionProvider(createScriptedDemoDecisions());
    const runtime = new AgentRuntime({
      guestTransport: guest,
      toolRegistry: createGuestToolRegistry(guest, {
        defaultTimeoutMs: config.toolTimeoutMs,
      }),
      verifier: new CriterionVerifierRegistry(guest),
      decisionProvider: provider,
      taskPlanner: new ScriptedTaskPlanner(task),
      repository: runAdapter,
      events: runtimeEvents,
      budgets: {
        maxSteps: config.maxSteps,
        maxRepeatedAction: config.maxRepeatedAction,
        maxConsecutiveFailures: config.maxConsecutiveFailures,
        toolTimeoutMs: config.toolTimeoutMs,
      },
    });
    const cancellation = new AbortController();
    const runId = `run-${randomUUID()}`;
    activeRuns.set(runId, { runtime, cancellation });
    try {
      const result = await runtime.run({
        threadId,
        userMessage: task.goal,
        task,
        runId,
        sourceMessageId,
        signal: cancellation.signal,
      });
      return database.runs.getById(result.run.id) ?? result.run;
    } finally {
      activeRuns.delete(runId);
    }
  };

  const handle = async (request: Request, server?: { upgrade(request: Request, options?: unknown): boolean }): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname === '/api/events' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      if (!server?.upgrade(request)) return errorResponse('WEBSOCKET_UPGRADE_FAILED', 'Could not upgrade the WebSocket.', 400);
      return undefined;
    }
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' } });
    if (!url.pathname.startsWith('/api/')) return notFound();

    try {
      const segments = pathSegments(url.pathname);
      if (request.method === 'GET' && url.pathname === '/api/health') {
        const diagnostics = database.diagnostics();
        const vmStatus = await vm.status();
        return jsonResponse({
          ok: diagnostics.sqlite,
          database: diagnostics.sqlite,
          fts5: diagnostics.fts5,
          sqliteVec: diagnostics.sqliteVec,
          vmHelper: vmStatus.helperAvailable,
          vm: vmStatus,
          browser: vmStatus.guestConnected,
          desktop: vmStatus.guestConnected,
          diagnostics,
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/threads') return jsonResponse({ threads: database.threads.list() });
      if (request.method === 'POST' && url.pathname === '/api/threads') {
        const input = threadInputSchema.parse(await parseBody(request));
        return jsonResponse({ thread: database.threads.create({ title: input.title }) }, 201);
      }
      if (segments[0] === 'api' && segments[1] === 'threads' && segments.length === 3) {
        const threadId = segments[2];
        if (request.method === 'GET') {
          const thread = database.threads.getById(threadId);
          if (!thread) return notFound('Thread not found.');
          return jsonResponse({ thread, messages: database.messages.listByThread(threadId), runs: database.runs.listByThread(threadId) });
        }
        if (request.method === 'DELETE') {
          if (!database.threads.delete(threadId)) return notFound('Thread not found.');
          return jsonResponse({ ok: true });
        }
      }
      if (segments[0] === 'api' && segments[1] === 'threads' && segments[3] === 'messages') {
        const threadId = segments[2];
        if (!database.threads.getById(threadId)) return notFound('Thread not found.');
        if (request.method === 'GET') return jsonResponse({ messages: database.messages.listByThread(threadId) });
        if (request.method === 'POST') {
          const input = messageInputSchema.parse(await parseBody(request));
          return jsonResponse({ message: database.messages.create({ threadId, role: input.role as MessageRole, content: input.content, metadata: jsonObject(input.metadata) }) }, 201);
        }
      }

      if (request.method === 'GET' && segments[0] === 'api' && segments[1] === 'runs' && segments.length === 3) {
        const run = database.runs.getById(segments[2]);
        if (!run) return notFound('Run not found.');
        return jsonResponse({ run: { ...run, steps: database.runSteps.listByRun(run.id) } });
      }
      if (request.method === 'POST' && url.pathname === '/api/runs/scripted-demo') {
        const input = scriptedDemoInputSchema.parse(await parseBody(request));
        const thread = input.threadId ? database.threads.getById(input.threadId) : undefined;
        if (input.threadId && !thread) return notFound('Thread not found.');
        const selectedThread = thread ?? database.threads.create({ title: 'Scripted Helm demo' });
        const task = createScriptedDemoTask(selectedThread.id);
        const message = database.messages.create({ threadId: selectedThread.id, role: 'user', content: task.goal, metadata: { source: 'scripted-demo' } });
        const run = await runScriptedDemo(selectedThread.id, message.id);
        return jsonResponse({ run: { ...run, steps: database.runSteps.listByRun(run.id) } }, 201);
      }
      if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[3] === 'cancel') {
        const runId = segments[2];
        const active = activeRuns.get(runId);
        if (active) active.cancellation.abort('Run cancelled by user');
        const run = database.runs.getById(runId);
        if (!run) return notFound('Run not found.');
        return jsonResponse({ run });
      }

      if (request.method === 'GET' && url.pathname === '/api/memories') return jsonResponse({ memories: memory.list() });
      if (request.method === 'GET' && url.pathname === '/api/memories/search') return jsonResponse({ memories: await memory.search(url.searchParams.get('q') ?? '') });
      if (request.method === 'POST' && url.pathname === '/api/memories') {
        const input = memoryInputSchema.parse(await parseBody(request));
        const created = await memory.save(input as CreateMemoryInput);
        return jsonResponse({ memory: created }, 201);
      }
      if (request.method === 'DELETE' && segments[0] === 'api' && segments[1] === 'memories' && segments.length === 3) {
        if (!(await memory.delete(segments[2]))) return notFound('Memory not found.');
        return jsonResponse({ ok: true });
      }

      if (request.method === 'GET' && url.pathname === '/api/vm/status') return jsonResponse(await vm.status());
      if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'vm') {
        if (segments[2] === 'start') await vm.start();
        else if (segments[2] === 'stop') await vm.stop();
        else if (segments[2] === 'reset') await vm.reset();
        else return notFound('Unknown VM action.');
        return jsonResponse(await vm.status());
      }
      return notFound();
    } catch (error) {
      if (error instanceof ApiFailure) return errorResponse(error.code, error.message, error.status, error.details);
      const normalized = errorDetails(error);
      logger.error('API request failed', { component: 'api', error });
      return errorResponse(normalized.code, normalized.message, normalized.code === 'INTERNAL_ERROR' ? 500 : 400, normalized.details);
    }
  };

  return {
    config,
    database,
    memory,
    events,
    vm,
    handle,
    async close() {
      await vm.close();
      database.close();
    },
  };
}

export interface HelmServer {
  application: HelmApplication;
  server: ReturnType<typeof Bun.serve>;
  close(): Promise<void>;
}

export function startHelmServer(config: HelmConfig = loadConfig()): HelmServer {
  const application = createHelmApplication(config);
  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    fetch(request, bunServer) {
      return application.handle(request, bunServer);
    },
    websocket: {
      open(socket) {
        const eventSocket = socket as unknown as EventSocket;
        application.events.add(eventSocket);
        void application.vm.status().then(status => {
          application.events.publish('vm.status', jsonValue(status));
        });
      },
      close(socket) {
        application.events.remove(socket as unknown as EventSocket);
      },
      message() {
        // The event stream is server-to-client only in this version.
      },
    },
  });
  logger.info('Helm server listening', { component: 'server', url: `http://${config.host}:${server.port}` });
  return {
    application,
    server,
    close: async () => {
      server.stop(true);
      await application.close();
    },
  };
}
