import { randomUUID } from 'node:crypto';

import type { Database } from 'bun:sqlite';
import type {
  AgentDecision,
  CompletionCriterion,
  JsonObject,
  Message,
  MessageRole,
  Run,
  RunStatus,
  RunStep,
  RunStepPhase,
  TaskDefinition,
  ToolError,
  ToolResult,
  Thread,
  VerificationResult,
} from '@helm/shared';

import { jsonObject, parseJson, stableStringify } from './json';

const MESSAGE_ROLES = new Set<MessageRole>(['user', 'assistant', 'system', 'tool']);
const RUN_STATUSES = new Set<RunStatus>([
  'pending',
  'running',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);
const RUN_STEP_PHASES = new Set<RunStepPhase>([
  'observe',
  'reason',
  'act',
  'verify',
  'complete',
  'blocked',
  'failed',
]);

export type IdFactory = () => string;

const defaultId: IdFactory = () => randomUUID();

function now(): string {
  return new Date().toISOString();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return value;
}

function parseMetadata(raw: string, field: string): JsonObject {
  return jsonObject(parseJson<unknown>(raw, field), field);
}

function parseNullableJson<T>(raw: string | null, field: string): T | undefined {
  return raw === null ? undefined : parseJson<T>(raw, field);
}

function normalizeLimit(limit: number | undefined, fallback = 100): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError('limit must be a positive integer');
  }
  return limit;
}

function mapThread(row: unknown): Thread {
  const value = row as {
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
  };
  return {
    id: requiredString(value.id, 'thread.id'),
    title: requiredString(value.title, 'thread.title'),
    createdAt: requiredString(value.createdAt, 'thread.createdAt'),
    updatedAt: requiredString(value.updatedAt, 'thread.updatedAt'),
  };
}

function mapMessage(row: unknown): Message {
  const value = row as {
    id: string;
    threadId: string;
    role: string;
    content: string;
    metadataJson: string;
    createdAt: string;
  };
  if (!MESSAGE_ROLES.has(value.role as MessageRole)) {
    throw new Error(`Invalid persisted message role: ${value.role}`);
  }
  return {
    id: requiredString(value.id, 'message.id'),
    threadId: requiredString(value.threadId, 'message.threadId'),
    role: value.role as MessageRole,
    content: requiredString(value.content, 'message.content'),
    metadata: parseMetadata(value.metadataJson, 'message.metadata_json'),
    createdAt: requiredString(value.createdAt, 'message.createdAt'),
  };
}

function mapRun(row: unknown): Run {
  const value = row as {
    id: string;
    threadId: string;
    sourceMessageId: string | null;
    goal: string;
    status: string;
    criteriaJson: string;
    errorJson: string | null;
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
  };
  if (!RUN_STATUSES.has(value.status as RunStatus)) {
    throw new Error(`Invalid persisted run status: ${value.status}`);
  }
  return {
    id: requiredString(value.id, 'run.id'),
    threadId: requiredString(value.threadId, 'run.threadId'),
    ...(value.sourceMessageId === null ? {} : { sourceMessageId: value.sourceMessageId }),
    goal: requiredString(value.goal, 'run.goal'),
    status: value.status as RunStatus,
    criteria: parseJson<CompletionCriterion[]>(value.criteriaJson, 'run.criteria_json'),
    ...(value.errorJson === null ? {} : { error: parseJson<ToolError>(value.errorJson, 'run.error') }),
    createdAt: requiredString(value.createdAt, 'run.createdAt'),
    ...(value.startedAt === null ? {} : { startedAt: value.startedAt }),
    ...(value.completedAt === null ? {} : { completedAt: value.completedAt }),
  };
}

function mapRunStep(row: unknown): RunStep {
  const value = row as {
    id: string;
    runId: string;
    stepIndex: number;
    phase: string;
    decisionJson: string | null;
    toolName: string | null;
    toolInputJson: string | null;
    toolResultJson: string | null;
    observationJson: string | null;
    verificationJson: string | null;
    createdAt: string;
    completedAt: string | null;
  };
  if (!RUN_STEP_PHASES.has(value.phase as RunStepPhase)) {
    throw new Error(`Invalid persisted run step phase: ${value.phase}`);
  }
  return {
    id: requiredString(value.id, 'runStep.id'),
    runId: requiredString(value.runId, 'runStep.runId'),
    stepIndex: value.stepIndex,
    phase: value.phase as RunStepPhase,
    ...(value.decisionJson === null
      ? {}
      : { decision: parseJson<AgentDecision>(value.decisionJson, 'run_step.decision_json') }),
    ...(value.toolName === null ? {} : { toolName: value.toolName }),
    ...(value.toolInputJson === null
      ? {}
      : { toolInput: parseJson<Record<string, unknown>>(value.toolInputJson, 'run_step.tool_input_json') }),
    ...(value.toolResultJson === null
      ? {}
      : { toolResult: parseJson<ToolResult>(value.toolResultJson, 'run_step.tool_result_json') }),
    ...(value.observationJson === null
      ? {}
      : { observation: parseJson<unknown>(value.observationJson, 'run_step.observation_json') }),
    ...(value.verificationJson === null
      ? {}
      : { verification: parseJson<VerificationResult>(value.verificationJson, 'run_step.verification_json') }),
    createdAt: requiredString(value.createdAt, 'runStep.createdAt'),
    ...(value.completedAt === null ? {} : { completedAt: value.completedAt }),
  };
}

export interface CreateThreadInput {
  title: string;
  id?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UpdateThreadInput {
  title?: string;
  updatedAt?: string;
}

export class ThreadRepository {
  constructor(
    private readonly database: Database,
    private readonly idFactory: IdFactory = defaultId,
  ) {}

  create(input: CreateThreadInput): Thread {
    const id = input.id ?? this.idFactory();
    const createdAt = input.createdAt ?? now();
    const updatedAt = input.updatedAt ?? createdAt;
    requiredString(input.title, 'thread.title');
    this.database
      .prepare(
        'INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)',
      )
      .run(id, input.title, createdAt, updatedAt);
    return this.getById(id) as Thread;
  }

  getById(id: string): Thread | undefined {
    const row = this.database
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM threads WHERE id = ?',
      )
      .get(id);
    return row === null ? undefined : mapThread(row);
  }

  get(id: string): Thread | undefined {
    return this.getById(id);
  }

  findById(id: string): Thread | undefined {
    return this.getById(id);
  }

  list(limit?: number): Thread[] {
    const rows = this.database
      .prepare(
        'SELECT id, title, created_at AS createdAt, updated_at AS updatedAt FROM threads ORDER BY updated_at DESC, id DESC LIMIT ?',
      )
      .all(normalizeLimit(limit));
    return rows.map(mapThread);
  }

  update(id: string, input: UpdateThreadInput): Thread | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const title = input.title ?? current.title;
    requiredString(title, 'thread.title');
    const updatedAt = input.updatedAt ?? now();
    this.database
      .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
      .run(title, updatedAt, id);
    return this.getById(id);
  }

  updateTitle(id: string, title: string, updatedAt?: string): Thread | undefined {
    return this.update(id, { title, updatedAt });
  }

  touch(id: string, updatedAt = now()): boolean {
    return this.database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(updatedAt, id).changes > 0;
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM threads WHERE id = ?').run(id).changes > 0;
  }

  count(): number {
    const row = this.database.prepare('SELECT COUNT(*) AS count FROM threads').get() as { count: number };
    return row.count;
  }
}

export interface CreateMessageInput {
  threadId: string;
  role: MessageRole;
  content: string;
  metadata?: JsonObject;
  id?: string;
  createdAt?: string;
}

export class MessageRepository {
  constructor(
    private readonly database: Database,
    private readonly idFactory: IdFactory = defaultId,
  ) {}

  create(input: CreateMessageInput): Message {
    if (!MESSAGE_ROLES.has(input.role)) throw new Error(`Invalid message role: ${input.role}`);
    const id = input.id ?? this.idFactory();
    const createdAt = input.createdAt ?? now();
    requiredString(input.threadId, 'message.threadId');
    if (typeof input.content !== 'string') throw new Error('Invalid message.content');
    const metadata = input.metadata ?? {};
    jsonObject(metadata, 'message.metadata');

    const insert = this.database.transaction(() => {
      this.database
        .prepare(
          'INSERT INTO messages (id, thread_id, role, content, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.threadId, input.role, input.content, stableStringify(metadata), createdAt);
      this.database.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(createdAt, input.threadId);
    });
    insert.immediate();
    return this.getById(id) as Message;
  }

  getById(id: string): Message | undefined {
    const row = this.database
      .prepare(
        'SELECT id, thread_id AS threadId, role, content, metadata_json AS metadataJson, created_at AS createdAt FROM messages WHERE id = ?',
      )
      .get(id);
    return row === null ? undefined : mapMessage(row);
  }

  get(id: string): Message | undefined {
    return this.getById(id);
  }

  findById(id: string): Message | undefined {
    return this.getById(id);
  }

  listByThread(threadId: string, limit?: number): Message[] {
    const rows = this.database
      .prepare(
        'SELECT id, thread_id AS threadId, role, content, metadata_json AS metadataJson, created_at AS createdAt FROM messages WHERE thread_id = ? ORDER BY created_at ASC, id ASC LIMIT ?',
      )
      .all(threadId, normalizeLimit(limit));
    return rows.map(mapMessage);
  }

  list(threadId: string, limit?: number): Message[] {
    return this.listByThread(threadId, limit);
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM messages WHERE id = ?').run(id).changes > 0;
  }

  countByThread(threadId: string): number {
    const row = this.database
      .prepare('SELECT COUNT(*) AS count FROM messages WHERE thread_id = ?')
      .get(threadId) as { count: number };
    return row.count;
  }
}

export interface CreateRunInput {
  threadId: string;
  goal: string;
  criteria: CompletionCriterion[];
  id?: string;
  sourceMessageId?: string;
  status?: RunStatus;
  error?: ToolError;
  createdAt?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface UpdateRunInput {
  goal?: string;
  criteria?: CompletionCriterion[];
  sourceMessageId?: string | null;
  error?: ToolError | null;
  startedAt?: string | null;
  completedAt?: string | null;
}

const TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  pending: ['running', 'blocked', 'failed', 'cancelled'],
  running: ['blocked', 'completed', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  failed: ['running', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class RunStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunStateError';
  }
}

export class RunRepository {
  constructor(
    private readonly database: Database,
    private readonly idFactory: IdFactory = defaultId,
  ) {}

  create(input: CreateRunInput): Run {
    const id = input.id ?? this.idFactory();
    const status = input.status ?? 'pending';
    if (!RUN_STATUSES.has(status)) throw new Error(`Invalid run status: ${status}`);
    requiredString(input.threadId, 'run.threadId');
    requiredString(input.goal, 'run.goal');
    if (!Array.isArray(input.criteria)) throw new Error('run.criteria must be an array');
    const createdAt = input.createdAt ?? now();
    this.database
      .prepare(
        'INSERT INTO runs (id, thread_id, source_message_id, goal, status, criteria_json, error, created_at, started_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.threadId,
        input.sourceMessageId ?? null,
        input.goal,
        status,
        stableStringify(input.criteria),
        input.error === undefined ? null : stableStringify(input.error),
        createdAt,
        input.startedAt ?? null,
        input.completedAt ?? null,
      );
    return this.getById(id) as Run;
  }

  getById(id: string): Run | undefined {
    const row = this.database
      .prepare(
        'SELECT id, thread_id AS threadId, source_message_id AS sourceMessageId, goal, status, criteria_json AS criteriaJson, error AS errorJson, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM runs WHERE id = ?',
      )
      .get(id);
    return row === null ? undefined : mapRun(row);
  }

  get(id: string): Run | undefined {
    return this.getById(id);
  }

  findById(id: string): Run | undefined {
    return this.getById(id);
  }

  listByThread(threadId: string, limit?: number): Run[] {
    const rows = this.database
      .prepare(
        'SELECT id, thread_id AS threadId, source_message_id AS sourceMessageId, goal, status, criteria_json AS criteriaJson, error AS errorJson, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM runs WHERE thread_id = ? ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(threadId, normalizeLimit(limit));
    return rows.map(mapRun);
  }

  list(threadId?: string, limit?: number): Run[] {
    if (threadId !== undefined) return this.listByThread(threadId, limit);
    const rows = this.database
      .prepare(
        'SELECT id, thread_id AS threadId, source_message_id AS sourceMessageId, goal, status, criteria_json AS criteriaJson, error AS errorJson, created_at AS createdAt, started_at AS startedAt, completed_at AS completedAt FROM runs ORDER BY created_at DESC, id DESC LIMIT ?',
      )
      .all(normalizeLimit(limit));
    return rows.map(mapRun);
  }

  update(id: string, input: UpdateRunInput): Run | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const goal = input.goal ?? current.goal;
    const criteria = input.criteria ?? current.criteria;
    requiredString(goal, 'run.goal');
    if (!Array.isArray(criteria)) throw new Error('run.criteria must be an array');
    const error = input.error === undefined ? current.error : input.error;
    this.database
      .prepare(
        'UPDATE runs SET source_message_id = ?, goal = ?, criteria_json = ?, error = ?, started_at = ?, completed_at = ? WHERE id = ?',
      )
      .run(
        input.sourceMessageId === undefined ? current.sourceMessageId ?? null : input.sourceMessageId,
        goal,
        stableStringify(criteria),
        error === undefined || error === null ? null : stableStringify(error),
        input.startedAt === undefined ? current.startedAt ?? null : input.startedAt,
        input.completedAt === undefined ? current.completedAt ?? null : input.completedAt,
        id,
      );
    return this.getById(id);
  }

  transition(id: string, status: RunStatus, error?: ToolError): Run | undefined {
    if (!RUN_STATUSES.has(status)) throw new RunStateError(`Invalid run status: ${status}`);
    const current = this.getById(id);
    if (!current) return undefined;
    if (current.status === status) return current;
    if (!TRANSITIONS[current.status].includes(status)) {
      throw new RunStateError(`Cannot transition run ${id} from ${current.status} to ${status}`);
    }
    const timestamp = now();
    const startedAt = status === 'running' ? current.startedAt ?? timestamp : current.startedAt;
    const completedAt = ['completed', 'failed', 'cancelled'].includes(status) ? timestamp : current.completedAt;
    this.database
      .prepare('UPDATE runs SET status = ?, error = ?, started_at = ?, completed_at = ? WHERE id = ?')
      .run(
        status,
        error === undefined ? current.error ? stableStringify(current.error) : null : stableStringify(error),
        startedAt ?? null,
        completedAt ?? null,
        id,
      );
    return this.getById(id);
  }

  start(id: string): Run | undefined {
    return this.transition(id, 'running');
  }

  complete(id: string): Run | undefined {
    return this.transition(id, 'completed');
  }

  fail(id: string, error: ToolError): Run | undefined {
    return this.transition(id, 'failed', error);
  }

  block(id: string, error?: ToolError): Run | undefined {
    return this.transition(id, 'blocked', error);
  }

  cancel(id: string, error?: ToolError): Run | undefined {
    return this.transition(id, 'cancelled', error);
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM runs WHERE id = ?').run(id).changes > 0;
  }
}

export interface CreateRunStepInput {
  runId: string;
  stepIndex?: number;
  phase: RunStepPhase;
  decision?: AgentDecision;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: ToolResult;
  observation?: unknown;
  verification?: VerificationResult;
  id?: string;
  createdAt?: string;
  completedAt?: string;
}

export interface UpdateRunStepInput {
  phase?: RunStepPhase;
  decision?: AgentDecision | null;
  toolName?: string | null;
  toolInput?: Record<string, unknown> | null;
  toolResult?: ToolResult | null;
  observation?: unknown;
  verification?: VerificationResult | null;
  completedAt?: string | null;
}

export class RunStepRepository {
  constructor(
    private readonly database: Database,
    private readonly idFactory: IdFactory = defaultId,
  ) {}

  private nextStepIndex(runId: string): number {
    const row = this.database
      .prepare('SELECT COALESCE(MAX(step_index), -1) AS nextIndex FROM run_steps WHERE run_id = ?')
      .get(runId) as { nextIndex: number };
    return row.nextIndex + 1;
  }

  create(input: CreateRunStepInput): RunStep {
    if (!RUN_STEP_PHASES.has(input.phase)) throw new Error(`Invalid run step phase: ${input.phase}`);
    if (input.stepIndex !== undefined && (!Number.isInteger(input.stepIndex) || input.stepIndex < 0)) {
      throw new RangeError('run step index must be a non-negative integer');
    }
    const id = input.id ?? this.idFactory();
    const createdAt = input.createdAt ?? now();
    const stepIndex = input.stepIndex ?? this.nextStepIndex(input.runId);
    this.database
      .prepare(
        'INSERT INTO run_steps (id, run_id, step_index, phase, decision_json, tool_name, tool_input_json, tool_result_json, observation_json, verification_json, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        input.runId,
        stepIndex,
        input.phase,
        input.decision === undefined ? null : stableStringify(input.decision),
        input.toolName ?? null,
        input.toolInput === undefined ? null : stableStringify(input.toolInput),
        input.toolResult === undefined ? null : stableStringify(input.toolResult),
        input.observation === undefined ? null : stableStringify(input.observation),
        input.verification === undefined ? null : stableStringify(input.verification),
        createdAt,
        input.completedAt ?? null,
      );
    return this.getById(id) as RunStep;
  }

  append(input: CreateRunStepInput): RunStep {
    return this.create(input);
  }

  getById(id: string): RunStep | undefined {
    const row = this.database
      .prepare(
        'SELECT id, run_id AS runId, step_index AS stepIndex, phase, decision_json AS decisionJson, tool_name AS toolName, tool_input_json AS toolInputJson, tool_result_json AS toolResultJson, observation_json AS observationJson, verification_json AS verificationJson, created_at AS createdAt, completed_at AS completedAt FROM run_steps WHERE id = ?',
      )
      .get(id);
    return row === null ? undefined : mapRunStep(row);
  }

  get(id: string): RunStep | undefined {
    return this.getById(id);
  }

  listByRun(runId: string, limit?: number): RunStep[] {
    const rows = this.database
      .prepare(
        'SELECT id, run_id AS runId, step_index AS stepIndex, phase, decision_json AS decisionJson, tool_name AS toolName, tool_input_json AS toolInputJson, tool_result_json AS toolResultJson, observation_json AS observationJson, verification_json AS verificationJson, created_at AS createdAt, completed_at AS completedAt FROM run_steps WHERE run_id = ? ORDER BY step_index ASC, created_at ASC, id ASC LIMIT ?',
      )
      .all(runId, normalizeLimit(limit));
    return rows.map(mapRunStep);
  }

  list(runId: string, limit?: number): RunStep[] {
    return this.listByRun(runId, limit);
  }

  update(id: string, input: UpdateRunStepInput): RunStep | undefined {
    const current = this.getById(id);
    if (!current) return undefined;
    const phase = input.phase ?? current.phase;
    if (!RUN_STEP_PHASES.has(phase)) throw new Error(`Invalid run step phase: ${phase}`);
    this.database
      .prepare(
        'UPDATE run_steps SET phase = ?, decision_json = ?, tool_name = ?, tool_input_json = ?, tool_result_json = ?, observation_json = ?, verification_json = ?, completed_at = ? WHERE id = ?',
      )
      .run(
        phase,
        input.decision === undefined
          ? current.decision === undefined ? null : stableStringify(current.decision)
          : input.decision === null ? null : stableStringify(input.decision),
        input.toolName === undefined ? current.toolName ?? null : input.toolName,
        input.toolInput === undefined
          ? current.toolInput === undefined ? null : stableStringify(current.toolInput)
          : input.toolInput === null ? null : stableStringify(input.toolInput),
        input.toolResult === undefined
          ? current.toolResult === undefined ? null : stableStringify(current.toolResult)
          : input.toolResult === null ? null : stableStringify(input.toolResult),
        input.observation === undefined
          ? current.observation === undefined ? null : stableStringify(current.observation)
          : stableStringify(input.observation),
        input.verification === undefined
          ? current.verification === undefined ? null : stableStringify(current.verification)
          : input.verification === null ? null : stableStringify(input.verification),
        input.completedAt === undefined ? current.completedAt ?? null : input.completedAt,
        id,
      );
    return this.getById(id);
  }

  complete(id: string, patch: Omit<UpdateRunStepInput, 'completedAt'> = {}): RunStep | undefined {
    return this.update(id, { ...patch, completedAt: now() });
  }

  delete(id: string): boolean {
    return this.database.prepare('DELETE FROM run_steps WHERE id = ?').run(id).changes > 0;
  }
}

/** Convenience aggregate for callers that want all persistence repositories at once. */
export interface PersistenceRepositories {
  threads: ThreadRepository;
  messages: MessageRepository;
  runs: RunRepository;
  runSteps: RunStepRepository;
}

export type PersistedTask = TaskDefinition;
