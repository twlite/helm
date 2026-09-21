import { z } from 'zod';

import type { ToolError, ToolResult } from '@helm/shared';

export interface ToolExecutionContext {
  signal: AbortSignal;
  toolName: string;
  runId?: string;
  stepIndex?: number;
  previousResults: readonly ToolResult[];
}

export type ToolHandler<TInput, TOutput> = (
  input: TInput,
  context: ToolExecutionContext,
) => Promise<ToolResult<TOutput> | TOutput> | ToolResult<TOutput> | TOutput;

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema?: z.ZodType<TInput>;
  /** `schema` is an accepted alias for integrations that use that spelling. */
  schema?: z.ZodType<TInput>;
  timeoutMs?: number;
  execute: ToolHandler<TInput, TOutput>;
}

export interface ToolInvocationRecord {
  id: string;
  tool: string;
  input: unknown;
  result: ToolResult;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface ToolRegistryOptions {
  defaultTimeoutMs?: number;
  onInvocation?: (record: ToolInvocationRecord) => void | Promise<void>;
  idFactory?: () => string;
}

export interface ToolExecuteOptions {
  signal?: AbortSignal;
  runId?: string;
  stepIndex?: number;
  previousResults?: readonly ToolResult[];
  /** Runtime-level override; the definition timeout remains the default. */
  timeoutMs?: number;
}

export class ToolRegistryError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ToolRegistryError';
    this.code = code;
  }
}

interface TimeoutSignal {
  signal: AbortSignal;
  timedOut: () => boolean;
  cleanup: () => void;
}

type RegisteredToolDefinition = {
  name: string;
  description: string;
  inputSchema: z.ZodType<unknown>;
  timeoutMs: number;
  execute: ToolHandler<unknown, unknown>;
};

function defaultIdFactory(): string {
  return `tool-invocation-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    'ok' in value &&
    typeof (value as { ok?: unknown }).ok === 'boolean' &&
    ('data' in value || 'error' in value || 'evidence' in value)
  );
}

function normalizeResult(value: unknown): ToolResult {
  if (isToolResult(value)) return value;
  return value === undefined ? { ok: true } : { ok: true, data: value };
}

function errorResult(code: string, message: string, details?: unknown): ToolResult {
  const error: ToolError = { code, message };
  if (details !== undefined && isJsonLike(details)) error.details = details;
  return { ok: false, error };
}

function isJsonLike(value: unknown): value is NonNullable<ToolError['details']> {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonLike);
  if (typeof value !== 'object') return false;
  return Object.values(value as Record<string, unknown>).every(isJsonLike);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function makeTimeoutSignal(parent: AbortSignal | undefined, timeoutMs: number): TimeoutSignal {
  const controller = new AbortController();
  let didTimeout = false;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) onParentAbort();
  else parent?.addEventListener('abort', onParentAbort, { once: true });
  const timer = setTimeout(() => {
    didTimeout = true;
    controller.abort(new Error('Tool execution timed out'));
  }, timeoutMs);
  return {
    signal: controller.signal,
    timedOut: () => didTimeout,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onParentAbort);
    },
  };
}

/** A typed, timeout-bounded registry for all agent actions. */
export class ToolRegistry {
  private readonly definitions = new Map<string, RegisteredToolDefinition>();
  private readonly trace: ToolInvocationRecord[] = [];
  private readonly defaultTimeoutMs: number;
  private readonly onInvocation?: ToolRegistryOptions['onInvocation'];
  private readonly idFactory: () => string;

  constructor(options: ToolRegistryOptions = {}) {
    this.defaultTimeoutMs = Math.max(1, options.defaultTimeoutMs ?? 30_000);
    this.onInvocation = options.onInvocation;
    this.idFactory = options.idFactory ?? defaultIdFactory;
  }

  register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): this {
    if (!definition.name.trim()) throw new ToolRegistryError('INVALID_DEFINITION', 'Tool name is required');
    if (this.definitions.has(definition.name)) {
      throw new ToolRegistryError('DUPLICATE_TOOL', `Tool is already registered: ${definition.name}`);
    }
    const inputSchema = definition.inputSchema ?? definition.schema;
    if (!inputSchema) {
      throw new ToolRegistryError('INVALID_DEFINITION', `A Zod input schema is required: ${definition.name}`);
    }
    const timeoutMs = definition.timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new ToolRegistryError('INVALID_TIMEOUT', `Tool timeout must be positive: ${definition.name}`);
    }
    this.definitions.set(definition.name, {
      name: definition.name,
      description: definition.description,
      inputSchema: inputSchema as z.ZodType<unknown>,
      timeoutMs,
      execute: definition.execute as unknown as ToolHandler<unknown, unknown>,
    });
    return this;
  }

  add<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): this {
    return this.register(definition);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.definitions.values()].map(definition => ({ ...definition }));
  }

  names(): string[] {
    return [...this.definitions.keys()].sort();
  }

  get invocations(): readonly ToolInvocationRecord[] {
    return this.trace.map(record => ({ ...record }));
  }

  clearInvocations(): void {
    this.trace.length = 0;
  }

  async execute(
    name: string,
    input: unknown,
    options: ToolExecuteOptions = {},
  ): Promise<ToolResult> {
    const startedAt = Date.now();
    const definition = this.definitions.get(name);
    let result: ToolResult;
    let parsedInput: unknown = input;

    if (!definition) {
      result = errorResult('UNKNOWN_TOOL', `Tool is not registered: ${name}`);
    } else {
      const parsed = definition.inputSchema.safeParse(input);
      if (!parsed.success) {
        result = errorResult('INVALID_INPUT', `Invalid input for ${name}`, parsed.error.issues);
      } else {
        parsedInput = parsed.data;
        result = await this.executeDefinition(definition, parsed.data, options);
      }
    }

    const completedAt = Date.now();
    const record: ToolInvocationRecord = {
      id: this.idFactory(),
      tool: name,
      input: parsedInput,
      result,
      startedAt,
      completedAt,
      durationMs: completedAt - startedAt,
    };
    this.trace.push(record);
    await this.onInvocation?.(record);
    return result;
  }

  private async executeDefinition(
    definition: RegisteredToolDefinition,
    input: unknown,
    options: ToolExecuteOptions,
  ): Promise<ToolResult> {
    const timeout = makeTimeoutSignal(
      options.signal,
      options.timeoutMs ?? definition.timeoutMs ?? this.defaultTimeoutMs,
    );
    const execution = Promise.resolve().then(() =>
      definition.execute(input, {
        signal: timeout.signal,
        toolName: definition.name,
        runId: options.runId,
        stepIndex: options.stepIndex,
        previousResults: options.previousResults ?? [],
      }),
    );
    execution.catch(() => undefined);

    try {
      const value = await Promise.race([
        execution,
        new Promise<never>((_, reject) => {
          const check = () => {
            if (timeout.timedOut()) reject(new ToolRegistryError('TOOL_TIMEOUT', `Tool timed out: ${definition.name}`));
            else if (timeout.signal.aborted && options.signal?.aborted) {
              reject(new ToolRegistryError('CANCELLED', `Tool cancelled: ${definition.name}`));
            }
          };
          timeout.signal.addEventListener('abort', check, { once: true });
          if (timeout.signal.aborted) check();
        }),
      ]);
      return normalizeResult(value);
    } catch (error) {
      if (error instanceof ToolRegistryError) return errorResult(error.code, error.message);
      if (timeout.timedOut()) return errorResult('TOOL_TIMEOUT', `Tool timed out: ${definition.name}`);
      if (options.signal?.aborted) return errorResult('CANCELLED', `Tool cancelled: ${definition.name}`);
      return errorResult('TOOL_ERROR', errorMessage(error));
    } finally {
      timeout.cleanup();
    }
  }
}

export type ToolResultEnvelope<T = unknown> = ToolResult<T>;
