import type {
  CompletionCriterion,
  JsonObject,
  JsonValue,
  MessageRole,
  ToolError,
} from '@helm/shared';
import type {
  HealthStatus,
  Memory,
  MemoryKind,
  Message,
  RunDetails,
  Thread,
  VmAction,
  VmStatus,
} from './types';

const configuredApiUrl = import.meta.env.VITE_API_URL?.trim();
const API_ROOT = configuredApiUrl ? configuredApiUrl.replace(/\/$/, '') : '';

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asBoolean(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asJsonObject(value: unknown): JsonObject {
  if (!isRecord(value)) {
    return {};
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    const parsed = asJsonValue(item);
    if (parsed !== undefined) {
      result[key] = parsed;
    }
  }
  return result;
}

function asJsonValue(value: unknown): JsonValue | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const parsed = asJsonValue(item);
      return parsed === undefined ? [] : [parsed];
    });
  }
  if (isRecord(value)) {
    return asJsonObject(value);
  }
  return undefined;
}

function readEnvelope(payload: unknown, key: string): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  return payload[key] ?? payload.data ?? payload;
}

function readArrayEnvelope(payload: unknown, key: string): unknown[] {
  const value = readEnvelope(payload, key);
  if (Array.isArray(value)) {
    return value;
  }
  if (isRecord(value) && Array.isArray(value[key])) {
    return value[key];
  }
  return [];
}

const messageRoles: MessageRole[] = ['user', 'assistant', 'system', 'tool'];
const memoryKinds: MemoryKind[] = ['fact', 'preference', 'instruction', 'note'];
const vmStates: VmStatus['state'][] = [
  'stopped',
  'starting',
  'running',
  'stopping',
  'error',
  'unavailable',
];

function parseThread(value: unknown): Thread | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  return {
    id: value.id,
    title: asString(value.title, 'Untitled thread'),
    createdAt: asString(value.createdAt ?? value.created_at),
    updatedAt: asString(value.updatedAt ?? value.updated_at),
  };
}

function parseMessage(value: unknown): Message | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  const role = messageRoles.includes(value.role as MessageRole)
    ? (value.role as MessageRole)
    : 'system';
  return {
    id: value.id,
    threadId: asString(value.threadId ?? value.thread_id),
    role,
    content: asString(value.content),
    metadata: asJsonObject(value.metadata ?? value.metadata_json),
    createdAt: asString(value.createdAt ?? value.created_at),
  };
}

function parseMemory(value: unknown): Memory | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  const kind = memoryKinds.includes(value.kind as MemoryKind)
    ? (value.kind as MemoryKind)
    : 'note';
  return {
    id: value.id,
    content: asString(value.content),
    kind,
    importance: Math.min(1, Math.max(0, asNumber(value.importance, 0.5))),
    metadata: asJsonObject(value.metadata ?? value.metadata_json),
    createdAt: asString(value.createdAt ?? value.created_at),
    updatedAt: asString(value.updatedAt ?? value.updated_at),
  };
}

function parseCriterion(value: unknown): CompletionCriterion | null {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return null;
  }
  switch (value.type) {
    case 'browser.url':
      return { type: 'browser.url', url: asString(value.url) };
    case 'file.exists':
      return { type: 'file.exists', path: asString(value.path) };
    case 'file.contains':
      return {
        type: 'file.contains',
        path: asString(value.path),
        expected: asString(value.expected),
      };
    case 'window.open':
      return {
        type: 'window.open',
        application: asOptionalString(value.application),
        titleIncludes: asOptionalString(value.titleIncludes),
      };
    case 'window.focused':
      return {
        type: 'window.focused',
        application: asOptionalString(value.application),
        titleIncludes: asOptionalString(value.titleIncludes),
      };
    case 'custom':
      return {
        type: 'custom',
        id: asString(value.id),
        description: asString(value.description),
      };
    default:
      return null;
  }
}

function parseToolError(value: unknown): ToolError | undefined {
  if (!isRecord(value) || typeof value.code !== 'string') {
    return undefined;
  }
  const details = asJsonValue(value.details);
  return {
    code: value.code,
    message: asString(value.message, 'Unknown error'),
    ...(details === undefined ? {} : { details }),
  };
}

function parseRun(value: unknown): RunDetails | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  const criteria = Array.isArray(value.criteria)
    ? value.criteria.flatMap((criterion) => {
        const parsed = parseCriterion(criterion);
        return parsed ? [parsed] : [];
      })
    : [];
  const rawSteps = value.steps ?? value.trace;
  const steps = Array.isArray(rawSteps)
    ? rawSteps.flatMap((step: unknown) => {
        const parsed = parseRunStep(step);
        return parsed ? [parsed] : [];
      })
    : [];
  return {
    id: value.id,
    threadId: asString(value.threadId ?? value.thread_id),
    sourceMessageId: asOptionalString(value.sourceMessageId ?? value.source_message_id),
    goal: asString(value.goal),
    status: parseRunStatus(value.status),
    criteria,
    error: parseToolError(value.error),
    createdAt: asString(value.createdAt ?? value.created_at),
    startedAt: asOptionalString(value.startedAt ?? value.started_at),
    completedAt: asOptionalString(value.completedAt ?? value.completed_at),
    steps,
  };
}

function parseRunStatus(value: unknown): RunDetails['status'] {
  switch (value) {
    case 'pending':
    case 'running':
    case 'blocked':
    case 'completed':
    case 'failed':
    case 'cancelled':
      return value;
    default:
      return 'pending';
  }
}

function parseRunStep(value: unknown): RunDetails['steps'][number] | null {
  if (!isRecord(value) || typeof value.id !== 'string') {
    return null;
  }
  const phase = parseRunStepPhase(value.phase);
  const decision = isRecord(value.decision) ? parseDecision(value.decision) : undefined;
  return {
    id: value.id,
    runId: asString(value.runId ?? value.run_id),
    stepIndex: asNumber(value.stepIndex ?? value.step_index, 0),
    phase,
    decision,
    toolName: asOptionalString(value.toolName ?? value.tool_name),
    toolInput: isRecord(value.toolInput ?? value.tool_input)
      ? (value.toolInput ?? value.tool_input) as Record<string, unknown>
      : undefined,
    toolResult: parseToolResult(value.toolResult ?? value.tool_result),
    observation: value.observation,
    verification: parseVerification(value.verification),
    createdAt: asString(value.createdAt ?? value.created_at),
    completedAt: asOptionalString(value.completedAt ?? value.completed_at),
  };
}

function parseRunStepPhase(value: unknown): RunDetails['steps'][number]['phase'] {
  switch (value) {
    case 'observe':
    case 'reason':
    case 'act':
    case 'verify':
    case 'complete':
    case 'blocked':
    case 'failed':
      return value;
    default:
      return 'observe';
  }
}

function parseDecision(value: RecordValue): import('@helm/shared').AgentDecision | undefined {
  switch (value.type) {
    case 'action':
      return {
        type: 'action',
        tool: asString(value.tool),
        input: isRecord(value.input) ? value.input : {},
        reasoningSummary: asOptionalString(value.reasoningSummary ?? value.reasoning_summary),
      };
    case 'complete':
      return {
        type: 'complete',
        reasoningSummary: asOptionalString(value.reasoningSummary ?? value.reasoning_summary),
      };
    case 'blocked':
      return {
        type: 'blocked',
        reason: asString(value.reason),
        reasoningSummary: asOptionalString(value.reasoningSummary ?? value.reasoning_summary),
      };
    default:
      return undefined;
  }
}

function parseToolResult(value: unknown): import('@helm/shared').ToolResult | undefined {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return undefined;
  }
  return {
    ok: value.ok,
    data: value.data,
    error: parseToolError(value.error),
    evidence: value.evidence,
  };
}

function parseVerification(value: unknown): import('@helm/shared').VerificationResult | undefined {
  if (!isRecord(value) || typeof value.complete !== 'boolean') {
    return undefined;
  }
  const criteria = Array.isArray(value.criteria)
    ? value.criteria.flatMap((criterion) => {
        if (!isRecord(criterion)) {
          return [];
        }
        const parsedCriterion = parseCriterion(criterion.criterion);
        if (!parsedCriterion) {
          return [];
        }
        return [
          {
            criterion: parsedCriterion,
            passed: asBoolean(criterion.passed),
            message: asString(criterion.message),
            evidence: criterion.evidence,
          },
        ];
      })
    : [];
  return {
    complete: value.complete,
    criteria,
    summary: asString(value.summary),
  };
}

function parseVmStatus(value: unknown): VmStatus {
  const input = isRecord(value) && isRecord(value.vm) ? value.vm : value;
  if (!isRecord(input)) {
    return {
      state: 'unavailable',
      helperAvailable: false,
      guestConnected: false,
      message: 'VM status unavailable',
    };
  }
  const rawState = input.state;
  const state = vmStates.includes(rawState as VmStatus['state'])
    ? (rawState as VmStatus['state'])
    : 'unavailable';
  return {
    state,
    helperAvailable: asBoolean(input.helperAvailable ?? input.helper_available),
    guestConnected: asBoolean(input.guestConnected ?? input.guest_connected),
    message: asOptionalString(input.message),
    screenshot: asOptionalString(input.screenshot),
  };
}

function parseHealth(value: unknown): HealthStatus {
  const input = isRecord(value) && isRecord(value.health) ? value.health : value;
  const vm = parseVmStatus(input);
  if (!isRecord(input)) {
    return {
      ok: false,
      database: false,
      fts5: false,
      sqliteVec: false,
      vmHelper: false,
      vm,
      browser: false,
      desktop: false,
    };
  }
  return {
    ok: asBoolean(input.ok),
    database: asBoolean(input.database),
    fts5: asBoolean(input.fts5),
    sqliteVec: asBoolean(input.sqliteVec ?? input.sqlite_vec),
    vmHelper: asBoolean(input.vmHelper ?? input.vm_helper),
    vm,
    browser: asBoolean(input.browser),
    desktop: asBoolean(input.desktop),
  };
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = text;
    }
  }
  if (!response.ok) {
    const errorPayload = isRecord(payload) && isRecord(payload.error) ? payload.error : payload;
    const error = isRecord(errorPayload) ? errorPayload : {};
    throw new ApiError(
      asString(error.message, `Request failed with status ${response.status}`),
      response.status,
      asOptionalString(error.code),
    );
  }
  return payload;
}

function jsonBody(value: Record<string, unknown>): RequestInit {
  return {
    method: 'POST',
    body: JSON.stringify(value),
  };
}

function parseSingle<T>(payload: unknown, key: string, parser: (value: unknown) => T | null): T {
  const result = parser(readEnvelope(payload, key));
  if (result === null) {
    throw new ApiError(`The server returned an invalid ${key} response`, 200, 'INVALID_RESPONSE');
  }
  return result;
}

export const helmApi = {
  async listThreads(): Promise<Thread[]> {
    const payload = await request('/api/threads');
    return readArrayEnvelope(payload, 'threads').flatMap((item) => {
      const thread = parseThread(item);
      return thread ? [thread] : [];
    });
  },

  async createThread(title: string): Promise<Thread> {
    const payload = await request('/api/threads', jsonBody({ title }));
    return parseSingle(payload, 'thread', parseThread);
  },

  async generateThreadTitle(threadId: string, sourceMessageId: string): Promise<Thread> {
    const payload = await request(
      `/api/threads/${encodeURIComponent(threadId)}/title`,
      jsonBody({ sourceMessageId }),
    );
    return parseSingle(payload, 'thread', parseThread);
  },

  async deleteThread(threadId: string): Promise<void> {
    await request(`/api/threads/${encodeURIComponent(threadId)}`, { method: 'DELETE' });
  },

  async listMessages(threadId: string): Promise<Message[]> {
    const payload = await request(`/api/threads/${encodeURIComponent(threadId)}/messages`);
    return readArrayEnvelope(payload, 'messages').flatMap((item) => {
      const message = parseMessage(item);
      return message ? [message] : [];
    });
  },

  async createMessage(threadId: string, content: string): Promise<Message> {
    const payload = await request(
      `/api/threads/${encodeURIComponent(threadId)}/messages`,
      jsonBody({ role: 'user', content }),
    );
    return parseSingle(payload, 'message', parseMessage);
  },

  async getRun(runId: string): Promise<RunDetails> {
    const payload = await request(`/api/runs/${encodeURIComponent(runId)}`);
    return parseSingle(payload, 'run', parseRun);
  },

  async runScriptedDemo(threadId: string): Promise<RunDetails> {
    const payload = await request('/api/runs/scripted-demo', jsonBody({ threadId }));
    return parseSingle(payload, 'run', parseRun);
  },

  async runAgent(threadId: string, sourceMessageId: string): Promise<RunDetails> {
    const payload = await request('/api/runs/agent', jsonBody({ threadId, sourceMessageId }));
    return parseSingle(payload, 'run', parseRun);
  },

  async queueAgent(threadId: string, sourceMessageId: string): Promise<{ queued: boolean; position: number; run?: RunDetails }> {
    const payload = await request('/api/runs/queue', jsonBody({ threadId, sourceMessageId }));
    const record = isRecord(payload) ? payload : {};
    const run = parseRun(record.run);
    return {
      queued: asBoolean(record.queued),
      position: asNumber(record.position),
      ...(run ? { run } : {}),
    };
  },

  async steerRun(runId: string, messageId: string): Promise<Message> {
    const payload = await request(
      `/api/runs/${encodeURIComponent(runId)}/steer`,
      jsonBody({ messageId }),
    );
    return parseSingle(payload, 'message', parseMessage);
  },

  async cancelRun(runId: string): Promise<void> {
    await request(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST' });
  },

  async listMemories(query?: string): Promise<Memory[]> {
    const path = query ? `/api/memories/search?q=${encodeURIComponent(query)}` : '/api/memories';
    const payload = await request(path);
    return readArrayEnvelope(payload, 'memories').flatMap((item) => {
      const memory = parseMemory(item);
      return memory ? [memory] : [];
    });
  },

  async createMemory(input: {
    content: string;
    kind: MemoryKind;
    importance: number;
  }): Promise<Memory> {
    const payload = await request('/api/memories', jsonBody(input));
    return parseSingle(payload, 'memory', parseMemory);
  },

  async deleteMemory(memoryId: string): Promise<void> {
    await request(`/api/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
  },

  async health(): Promise<HealthStatus> {
    return parseHealth(await request('/api/health'));
  },

  async vmStatus(): Promise<VmStatus> {
    return parseVmStatus(await request('/api/vm/status'));
  },

  async vmAction(action: VmAction): Promise<VmStatus> {
    return parseVmStatus(await request(`/api/vm/${action}`, { method: 'POST' }));
  },
};

export function getWebSocketUrl(): string {
  const configuredWebSocketUrl = import.meta.env.VITE_WS_URL?.trim();
  if (configuredWebSocketUrl) {
    return configuredWebSocketUrl;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/api/events`;
}

export function parseError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code ? `${error.message} (${error.code})` : error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'The request could not be completed.';
}
