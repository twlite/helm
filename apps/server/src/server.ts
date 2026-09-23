import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { z } from 'zod';
import type {
  JsonValue,
  GuestMethod,
  Memory,
  Message,
  MessageRole,
  Run,
  RunStep,
  ToolResult,
  WebSocketEvent,
} from '@helm/shared';
import { createLmStudioModels, fallbackThreadTitle } from './ai';
import { MockGuestTransport } from './tools/mock-guest-transport';
import { createGuestToolRegistry } from './tools/guest-tools';
import { CriterionVerifierRegistry } from './tools/criterion-verifier';
import {
  AgentRuntime,
  assistantMessageForResult,
  createScriptedDemoDecisions,
  createScriptedDemoTask,
  ScriptedDecisionProvider,
  ScriptedTaskPlanner,
} from './agent';
import type { RuntimeEvent, RuntimeEventSink, RuntimeRepository } from './agent';
import { PersistenceDatabase } from './db/database';
import type { CreateMemoryInput } from './memory/repository';
import { extractExplicitMemory, shouldAttemptModelMemoryExtraction } from './memory/remember';
import { MemoryService } from './memory/service';
import { EventHub, type EventSocket } from './events';
import { loadConfig, type HelmConfig } from './config';
import { logger } from './logger';
import { VmController } from './vm/vm-controller';
import type {
  GuestMethodParams,
  GuestMethodResult,
  GuestRequestOptions,
  GuestTransport,
} from './tools/guest-transport';

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
const agentRunInputSchema = z.object({
  threadId: z.string().min(1),
  sourceMessageId: z.string().min(1),
});
const steerRunInputSchema = z.object({
  messageId: z.string().min(1),
});
const threadTitleInputSchema = z.object({
  sourceMessageId: z.string().min(1),
  force: z.boolean().optional().default(false),
});

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
        task: run.task,
        state: run.state,
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
      task: run.task ?? null,
      state: run.state ?? null,
      startedAt: run.startedAt ?? null,
      completedAt: run.completedAt ?? null,
    });
  }

  saveStep(step: RunStep): void {
    if (this.database.runSteps.getById(step.id)) {
      this.database.runSteps.update(step.id, {
        phase: step.phase,
        decision: step.decision,
        orchestratorDecision: step.orchestratorDecision,
        objective: step.objective,
        worker: step.worker,
        workerResult: step.workerResult,
        progress: step.progress,
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
      orchestratorDecision: step.orchestratorDecision,
      objective: step.objective,
      worker: step.worker,
      workerResult: step.workerResult,
      progress: step.progress,
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

type ActiveRun = {
  runtime: AgentRuntime;
  cancellation: AbortController;
  threadId: string;
  conversation: Message[];
  steeringQueue: Message[];
  steeringHistory: Message[];
};

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
  const events = new EventHub();
  const vm = new VmController(config, events);
  const activeRuns = new Map<string, ActiveRun>();
  const activeThreadRuns = new Map<string, string>();
  const queuedAgentMessages = new Map<string, string[]>();
  let startNextQueuedRun: (threadId: string) => Promise<void> = async () => undefined;
  const runAdapter = new RuntimeDatabaseAdapter(database);
  const runtimeEvents = new RuntimeEvents(events);
  const realToolOptions = { defaultTimeoutMs: config.toolTimeoutMs };
  const agentGuest: GuestTransport = {
    request: async <M extends GuestMethod>(
      method: M,
      params: GuestMethodParams[M],
      options?: GuestRequestOptions,
    ): Promise<GuestMethodResult[M]> => vm.guestRequest<GuestMethodResult[M]>(
      method,
      params,
      options?.signal,
    ),
  };
  const models = createLmStudioModels(config);
  const memory = new MemoryService(database.sqlite, {
    embeddingProvider: models.embeddingProvider,
    sqliteVec: { dimensions: config.models.embeddingDimensions },
  });

  const isLegacyAutomaticMemory = (candidate: Memory): boolean => (
    candidate.metadata.source === 'automatic-user-memory'
    && /^(?:User correction|User instruction) to remember:/u.test(candidate.content)
  );

  let legacyMemoryUpgradePromise: Promise<void> | undefined;
  const upgradeLegacyMemories = async (): Promise<void> => {
    for (const candidate of memory.list(1_000).filter(isLegacyAutomaticMemory)) {
      const sourceMessageId = candidate.metadata.sourceMessageId;
      if (typeof sourceMessageId !== 'string') continue;
      const sourceMessage = database.messages.getById(sourceMessageId);
      if (!sourceMessage || sourceMessage.role !== 'user') continue;
      try {
        const summary = await models.memoryExtractor.extract({
          userMessage: sourceMessage.content,
          conversation: database.messages.listByThread(sourceMessage.threadId),
        });
        if (!summary) continue;
        await memory.update(candidate.id, summary);
        logger.info('Legacy automatic memory summarized', {
          component: 'memory',
          memoryId: candidate.id,
        });
      } catch (error) {
        // A legacy row remains usable if the local model is unavailable. It can
        // be retried after the next server restart without blocking the API.
        logger.warn('Legacy automatic memory summarization failed', {
          component: 'memory',
          memoryId: candidate.id,
          error,
        });
      }
    }
  };
  const ensureLegacyMemoryUpgrade = async (): Promise<void> => {
    if (!legacyMemoryUpgradePromise) {
      legacyMemoryUpgradePromise = upgradeLegacyMemories().catch(error => {
        logger.warn('Legacy memory upgrade failed', { component: 'memory', error });
      });
    }
    await legacyMemoryUpgradePromise;
  };

  const rememberUserMessage = async (message: Message): Promise<void> => {
    if (message.role !== 'user') return;
    const metadata = {
      source: 'automatic-user-memory',
      threadId: message.threadId,
      sourceMessageId: message.id,
    } satisfies Record<string, JsonValue>;
    const relatedUserMessages = database.messages
      .listByThread(message.threadId)
      .filter(candidate => candidate.role === 'user' && candidate.id !== message.id)
      .map(candidate => candidate.content);
    const explicitMemory = extractExplicitMemory(message.content, relatedUserMessages);
    const shouldExtract = explicitMemory !== undefined || shouldAttemptModelMemoryExtraction(message.content);
    const modelCandidate = shouldExtract
      ? await models.memoryExtractor.extract({
        userMessage: message.content,
        conversation: database.messages.listByThread(message.threadId),
      })
      : undefined;
    // Explicit memory intent wins even if the local model is temporarily
    // unavailable. The deterministic candidate is only a conservative
    // fallback; successful model extraction is what normally gets persisted.
    const candidate = modelCandidate ?? explicitMemory;
    if (!candidate) return;
    const existingAutomaticMemory = memory.list(1_000).find(existing => (
      existing.metadata.source === metadata.source
      && existing.metadata.sourceMessageId === message.id
    ));
    if (existingAutomaticMemory) {
      await memory.update(existingAutomaticMemory.id, candidate);
      return;
    }
    await memory.saveIfNew({
      ...candidate,
      metadata,
    });
  };

  const updateThreadTitleAfterRun = async (threadId: string, sourceMessageId: string): Promise<void> => {
    try {
      const thread = database.threads.getById(threadId);
      const sourceMessage = database.messages.getById(sourceMessageId);
      const firstUserMessage = database.messages.listByThread(threadId).find(message => message.role === 'user');
      const titleSource = firstUserMessage ?? sourceMessage;
      if (!thread || !titleSource || titleSource.role !== 'user') return;
      const fallbackTitle = fallbackThreadTitle(titleSource.content);
      if (thread.title !== fallbackTitle) return;
      const generatedTitle = await models.titleGenerator.generate(titleSource.content);
      if (!generatedTitle || generatedTitle === fallbackTitle) return;
      database.threads.updateTitle(threadId, generatedTitle);
      logger.info('Thread title generated', { component: 'thread', threadId });
    } catch (error) {
      // A title is an enhancement. Never turn a completed/failed agent run
      // into another failure because the local model was busy or unavailable.
      logger.warn('Thread title generation failed', { component: 'thread', threadId, error });
    }
  };

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
    const conversation = database.messages.listByThread(threadId);
    activeRuns.set(runId, {
      runtime,
      cancellation,
      threadId,
      conversation,
      steeringQueue: [],
      steeringHistory: [],
    });
    activeThreadRuns.set(threadId, runId);
    try {
      const result = await runtime.run({
        threadId,
        userMessage: task.goal,
        conversation,
        task,
        runId,
        sourceMessageId,
        signal: cancellation.signal,
        drainSteering: () => {
          const active = activeRuns.get(runId);
          if (!active) return [];
          return active.steeringQueue.splice(0);
        },
      });
      return database.runs.getById(result.run.id) ?? result.run;
    } finally {
      activeRuns.delete(runId);
      if (activeThreadRuns.get(threadId) === runId) activeThreadRuns.delete(threadId);
      await startNextQueuedRun(threadId);
    }
  };

  const createAiRuntime = (): AgentRuntime => {
    const tools = createGuestToolRegistry(agentGuest, realToolOptions);
    return new AgentRuntime({
      guestTransport: agentGuest,
      toolRegistry: tools,
      verifier: new CriterionVerifierRegistry(agentGuest),
      actingAgent: models.actingAgent,
      repository: runAdapter,
      events: runtimeEvents,
      memories: async ({ userMessage }) => {
        await ensureLegacyMemoryUpgrade();
        return memory.recall(userMessage);
      },
      budgets: {
        maxSteps: config.maxSteps,
        maxRepeatedAction: config.maxRepeatedAction,
        maxConsecutiveFailures: config.maxConsecutiveFailures,
        toolTimeoutMs: config.toolTimeoutMs,
      },
    });
  };

  const startAiRun = (threadId: string, sourceMessageId: string): Run => {
    if (activeThreadRuns.has(threadId)) {
      throw new ApiFailure('RUN_ALREADY_ACTIVE', 'A run is already active in this thread.', 409);
    }
    const sourceMessage = database.messages.getById(sourceMessageId);
    if (!sourceMessage || sourceMessage.threadId !== threadId) {
      throw new ApiFailure('MESSAGE_NOT_FOUND', 'The source message was not found in this thread.', 404);
    }

    const runId = `run-${randomUUID()}`;
    const pendingRun = database.runs.create({
      id: runId,
      threadId,
      sourceMessageId,
      goal: sourceMessage.content,
      criteria: [],
      status: 'pending',
    });
    const runtime = createAiRuntime();
    const cancellation = new AbortController();
    const conversation = database.messages.listByThread(threadId);
    activeRuns.set(runId, {
      runtime,
      cancellation,
      threadId,
      conversation,
      steeringQueue: [],
      steeringHistory: [],
    });
    activeThreadRuns.set(threadId, runId);
    void runtime.run({
      threadId,
      userMessage: sourceMessage.content,
      conversation,
      runId,
      sourceMessageId,
      signal: cancellation.signal,
      drainSteering: () => {
        const active = activeRuns.get(runId);
        if (!active) return [];
        return active.steeringQueue.splice(0);
      },
    }).then(async result => {
      const persistedRun = database.runs.getById(result.run.id) ?? result.run;
      const fallbackResponse = assistantMessageForResult(result);
      const generatedResponse = result.status === 'completed' ? result.assistantResponse ?? '' : '';
      const responseMessageId = generatedResponse ? `message-${randomUUID()}` : undefined;
      if (responseMessageId) {
        events.publish('assistant.message.started', jsonValue({
          threadId,
          messageId: responseMessageId,
        }), { runId });
        events.publish('assistant.message.delta', jsonValue({
          threadId,
          messageId: responseMessageId,
          delta: generatedResponse,
        }), { runId });
      }
      const message = database.messages.create({
        ...(responseMessageId ? { id: responseMessageId } : {}),
        threadId,
        role: 'assistant',
        content: generatedResponse || fallbackResponse,
        metadata: {
          source: 'ai-run',
          runId: persistedRun.id,
          status: persistedRun.status,
        },
      });
      if (responseMessageId) {
        events.publish('assistant.message.finished', jsonValue({
          threadId,
          messageId: responseMessageId,
          status: 'completed',
        }), { runId });
      }
      // The runtime emits run.completed before this response is durably
      // persisted, so clients refresh after message.created as well.
      await updateThreadTitleAfterRun(threadId, sourceMessageId);
      events.publish('message.created', jsonValue(message), { runId });
    }).catch(async error => {
      const normalized = errorDetails(error);
      const runError = { code: normalized.code, message: normalized.message };
      const cancelled = cancellation.signal.aborted;
      const currentRun = database.runs.getById(runId);
      const canTransition = currentRun !== undefined && ['pending', 'running'].includes(currentRun.status);
      if (cancelled && canTransition) {
        database.runs.cancel(runId, { code: 'RUN_CANCELLED', message: 'Run was cancelled.' });
      } else if (!cancelled && canTransition) {
        database.runs.fail(runId, runError);
      }
      const message = database.messages.create({
        threadId,
        role: 'assistant',
        content: cancelled ? 'Run was cancelled.' : normalized.message,
        metadata: { source: 'ai-run', runId, status: cancelled ? 'cancelled' : 'failed' },
      });
      await updateThreadTitleAfterRun(threadId, sourceMessageId);
      events.publish('message.created', jsonValue(message), { runId });
      if (canTransition) {
        runtimeEvents.emit({
          type: cancelled ? 'run.cancelled' : 'run.failed',
          timestamp: new Date().toISOString(),
          runId,
          payload: cancelled ? { code: 'RUN_CANCELLED', message: 'Run was cancelled.' } : runError,
        });
      }
    }).finally(() => {
      activeRuns.delete(runId);
      if (activeThreadRuns.get(threadId) === runId) activeThreadRuns.delete(threadId);
      void startNextQueuedRun(threadId);
    });
    return pendingRun;
  };

  const queueAiRun = (threadId: string, sourceMessageId: string): { queued: boolean; position: number; run?: Run } => {
    const sourceMessage = database.messages.getById(sourceMessageId);
    if (!sourceMessage || sourceMessage.threadId !== threadId || sourceMessage.role !== 'user') {
      throw new ApiFailure('MESSAGE_NOT_FOUND', 'The source message was not found in this thread.', 404);
    }
    if (!activeThreadRuns.has(threadId)) {
      return { queued: false, position: 0, run: startAiRun(threadId, sourceMessageId) };
    }
    const queue = queuedAgentMessages.get(threadId) ?? [];
    queue.push(sourceMessageId);
    queuedAgentMessages.set(threadId, queue);
    return { queued: true, position: queue.length };
  };

  startNextQueuedRun = async (threadId: string): Promise<void> => {
    if (activeThreadRuns.has(threadId)) return;
    const queue = queuedAgentMessages.get(threadId);
    const sourceMessageId = queue?.shift();
    if (queue === undefined || sourceMessageId === undefined) {
      queuedAgentMessages.delete(threadId);
      return;
    }
    if (queue.length === 0) queuedAgentMessages.delete(threadId);
    try {
      startAiRun(threadId, sourceMessageId);
    } catch (error) {
      const normalized = errorDetails(error);
      const message = database.messages.create({
        threadId,
        role: 'assistant',
        content: normalized.message,
        metadata: { source: 'ai-run', status: 'failed', code: normalized.code },
      });
      events.publish('message.created', jsonValue(message));
      await startNextQueuedRun(threadId);
    }
  };

  const steerAiRun = (runId: string, messageId: string): Message => {
    const active = activeRuns.get(runId);
    if (!active || !active.runtime.running) {
      throw new ApiFailure('RUN_NOT_ACTIVE', 'This run is no longer accepting steering messages.', 409);
    }
    const message = database.messages.getById(messageId);
    if (!message || message.threadId !== active.threadId || message.role !== 'user') {
      throw new ApiFailure('MESSAGE_NOT_FOUND', 'The steering message was not found in this run’s thread.', 404);
    }
    active.steeringQueue.push(message);
    active.steeringHistory.push(message);
    events.publish('message.created', jsonValue(message), { runId });
    return message;
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
      if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'threads' && segments.length === 4 && segments[3] === 'title') {
        const threadId = segments[2];
        const thread = database.threads.getById(threadId);
        if (!thread) return notFound('Thread not found.');
        const input = threadTitleInputSchema.parse(await parseBody(request));
        const sourceMessage = database.messages.getById(input.sourceMessageId);
        if (!sourceMessage || sourceMessage.threadId !== threadId || sourceMessage.role !== 'user') {
          throw new ApiFailure('MESSAGE_NOT_FOUND', 'The source message was not found in this thread.', 404);
        }
        const fallbackTitle = fallbackThreadTitle(sourceMessage.content);
        if (!input.force && thread.title !== fallbackTitle) {
          return jsonResponse({ thread });
        }
        const generatedTitle = await models.titleGenerator.generate(sourceMessage.content);
        const updatedThread = database.threads.updateTitle(threadId, generatedTitle || fallbackTitle);
        return jsonResponse({ thread: updatedThread ?? thread });
      }
      if (segments[0] === 'api' && segments[1] === 'threads' && segments[3] === 'messages') {
        const threadId = segments[2];
        if (!database.threads.getById(threadId)) return notFound('Thread not found.');
        if (request.method === 'GET') return jsonResponse({ messages: database.messages.listByThread(threadId) });
        if (request.method === 'POST') {
          const input = messageInputSchema.parse(await parseBody(request));
          const message = database.messages.create({
            threadId,
            role: input.role as MessageRole,
            content: input.content,
            metadata: jsonObject(input.metadata),
          });
          if (message.role === 'user') {
            try {
              await rememberUserMessage(message);
            } catch (error) {
              logger.warn('Automatic memory capture failed', {
                component: 'memory',
                threadId,
                sourceMessageId: message.id,
                error,
              });
            }
          }
          return jsonResponse({ message }, 201);
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
      if (request.method === 'POST' && url.pathname === '/api/runs/agent') {
        const input = agentRunInputSchema.parse(await parseBody(request));
        if (!database.threads.getById(input.threadId)) return notFound('Thread not found.');
        const run = startAiRun(input.threadId, input.sourceMessageId);
        return jsonResponse({ run: { ...run, steps: [] } }, 202);
      }
      if (request.method === 'POST' && url.pathname === '/api/runs/queue') {
        const input = agentRunInputSchema.parse(await parseBody(request));
        if (!database.threads.getById(input.threadId)) return notFound('Thread not found.');
        const queued = queueAiRun(input.threadId, input.sourceMessageId);
        return jsonResponse({
          queued: queued.queued,
          position: queued.position,
          ...(queued.run ? { run: { ...queued.run, steps: [] } } : {}),
        }, 202);
      }
      if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[3] === 'steer') {
        const input = steerRunInputSchema.parse(await parseBody(request));
        const message = steerAiRun(segments[2], input.messageId);
        return jsonResponse({ message });
      }
      if (request.method === 'POST' && segments[0] === 'api' && segments[1] === 'runs' && segments[3] === 'cancel') {
        const runId = segments[2];
        const active = activeRuns.get(runId);
        if (active) active.cancellation.abort('Run cancelled by user');
        const run = database.runs.getById(runId);
        if (!run) return notFound('Run not found.');
        return jsonResponse({ run });
      }

      if (request.method === 'GET' && url.pathname === '/api/memories') {
        await ensureLegacyMemoryUpgrade();
        return jsonResponse({ memories: memory.list() });
      }
      if (request.method === 'GET' && url.pathname === '/api/memories/search') {
        await ensureLegacyMemoryUpgrade();
        return jsonResponse({ memories: await memory.search(url.searchParams.get('q') ?? '') });
      }
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
        if (segments[2] === 'start') {
          const showWindow = url.searchParams.get('gui') === 'true' || url.searchParams.get('gui') === '1';
          await vm.start({ showWindow });
        }
        else if (segments[2] === 'stop') await vm.stop();
        else if (segments[2] === 'force-stop') await vm.forceStop();
        else if (segments[2] === 'reset') await vm.reset();
        else if (segments[2] === 'reconnect') await vm.reconnect();
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
      for (const active of activeRuns.values()) {
        active.cancellation.abort('Helm server is shutting down');
      }
      queuedAgentMessages.clear();
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
  const eventHeartbeatTimer = setInterval(() => {
    application.events.heartbeat();
  }, 15_000);
  logger.info('Helm server listening', { component: 'server', url: `http://${config.host}:${server.port}` });
  return {
    application,
    server,
    close: async () => {
      clearInterval(eventHeartbeatTimer);
      await server.stop(true);
      await application.close();
    },
  };
}
