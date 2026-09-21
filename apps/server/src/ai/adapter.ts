import { embed, generateText, Output, tool, type EmbeddingModel, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type {
  AgentDecision,
  AgentTurnContext,
  CompletionCriterion,
  TaskDefinition,
} from '@helm/shared';
import type { TaskPlanner, TaskPlannerInput } from '../agent/types';
import type { EmbeddingProvider } from '../memory/vector';
import type { ToolDefinition } from '../tools/registry';

/** The model boundary never owns tool execution, verification, or run state. */
export interface DecisionProviderBoundary {
  next(context: AgentTurnContext): Promise<AgentDecision>;
}

export interface AiSdkToolBoundary {
  description: string;
  inputSchema: z.ZodType;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Exposes the same validated Helm tool functions to a future AI SDK agent.
 * Execution still remains behind the Helm registry supplied by the caller.
 */
export function createAiSdkToolSet(definitions: Record<string, AiSdkToolBoundary>): ToolSet {
  const result: Record<string, unknown> = {};
  for (const [name, definition] of Object.entries(definitions)) {
    result[name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: input => definition.execute(input as Record<string, unknown>),
    });
  }
  return result as ToolSet;
}

export interface AiSdkDecisionProviderOptions {
  model: LanguageModel;
  tools?: ToolSet;
  toolDefinitions: readonly ToolDefinition[];
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

export class AiSdkDecisionProvider implements DecisionProviderBoundary {
  constructor(public readonly options: AiSdkDecisionProviderOptions) {}

  async next(context: AgentTurnContext): Promise<AgentDecision> {
    const result = await generateStructured({
      model: this.options.model,
      maxOutputTokens: this.options.maxOutputTokens,
      temperature: this.options.temperature,
      requestTimeoutMs: this.options.requestTimeoutMs,
      abortSignal: context.signal,
      schema: aiDecisionSchema,
      system: [
        'You are Helm, a local computer-use agent decision maker.',
        'Return exactly one JSON decision matching the provided schema.',
        'Choose only a tool from the available tool catalog and provide valid input for that tool.',
        'Do not claim success. Helm executes the action and verifies the result separately.',
        'Request completion only when every explicit task criterion is already satisfied.',
        'Keep reasoningSummary short, operational, and free of hidden chain-of-thought.',
      ].join(' '),
      prompt: [
        `Task:\n${promptJson(context.task, 6_000)}`,
        `Observation:\n${promptJson(context.observation, 8_000)}`,
        `Completed criteria:\n${promptJson(context.observation.task.completedCriteria, 3_000)}`,
        `Remaining criteria:\n${promptJson(context.observation.task.remainingCriteria, 3_000)}`,
        `Memories:\n${promptJson(context.memories, 8_000)}`,
        `Operational history:\n${promptJson(context.history, 12_000)}`,
        `Previous tool results:\n${promptJson(context.previousResults, 16_000)}`,
        `Available tools:\n${promptJson(toolCatalog(this.options.toolDefinitions), 18_000)}`,
      ].join('\n\n'),
    });
    return result;
  }
}

export interface AiSdkTaskPlannerOptions {
  model: LanguageModel;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

export interface AiSdkThreadTitleGeneratorOptions {
  model: LanguageModel;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

const criterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('browser.url'), url: z.string().min(1) }),
  z.object({ type: z.literal('file.exists'), path: z.string().min(1) }),
  z.object({ type: z.literal('file.contains'), path: z.string().min(1), expected: z.string() }),
  z.object({
    type: z.literal('window.open'),
    application: z.string().optional(),
    titleIncludes: z.string().optional(),
  }),
  z.object({
    type: z.literal('window.focused'),
    application: z.string().optional(),
    titleIncludes: z.string().optional(),
  }),
]);

export const aiTaskPlanSchema = z.object({
  goal: z.string().min(1),
  criteria: z.array(criterionSchema).min(1).max(12),
  maxSteps: z.number().int().min(1).max(64).optional(),
});

export const aiDecisionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('action'),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    reasoningSummary: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('complete'),
    reasoningSummary: z.string().max(400).optional(),
  }),
  z.object({
    type: z.literal('blocked'),
    reason: z.string().min(1),
    reasoningSummary: z.string().max(400).optional(),
  }),
]);

export const aiThreadTitleSchema = z.object({
  title: z.string().trim().min(1).max(80),
});

const MAX_THREAD_TITLE_LENGTH = 200;

/** Keep a useful title visible even when the model is unavailable. */
export function fallbackThreadTitle(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) return 'New thread';
  if (trimmed.length <= MAX_THREAD_TITLE_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_THREAD_TITLE_LENGTH - 3).trimEnd()}...`;
}

function toolCatalog(definitions: readonly ToolDefinition[]): Array<Record<string, unknown>> {
  return definitions.map(definition => {
    const schema = definition.inputSchema ?? definition.schema;
    let inputSchema: unknown = { type: 'object' };
    if (schema) {
      try {
        inputSchema = z.toJSONSchema(schema as z.ZodType);
      } catch {
        inputSchema = { type: 'object' };
      }
    }
    return {
      name: definition.name,
      description: definition.description,
      inputSchema,
    };
  });
}

function promptJson(value: unknown, maxCharacters: number): string {
  let serialized: string;
  try {
    serialized = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return '[unserializable]';
  }
  if (serialized.length <= maxCharacters) return serialized;
  return `${serialized.slice(0, maxCharacters)}\n...[truncated by Helm]`;
}

async function generateStructured<T extends z.ZodType>(options: {
  model: LanguageModel;
  schema: T;
  system: string;
  prompt: string;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<z.infer<T>> {
  const response = await generateText({
    model: options.model,
    system: options.system,
    prompt: options.prompt,
    output: Output.object({ schema: options.schema }),
    maxOutputTokens: options.maxOutputTokens,
    temperature: options.temperature,
    timeout: options.requestTimeoutMs,
    maxRetries: 0,
    abortSignal: options.abortSignal,
  });
  return options.schema.parse(response.output) as z.infer<T>;
}

export class AiSdkTaskPlanner implements TaskPlanner {
  constructor(public readonly options: AiSdkTaskPlannerOptions) {}

  async createTask(input: TaskPlannerInput): Promise<TaskDefinition> {
    const plan = await generateStructured({
      model: this.options.model,
      maxOutputTokens: this.options.maxOutputTokens,
      temperature: this.options.temperature,
      requestTimeoutMs: this.options.requestTimeoutMs,
      abortSignal: input.signal,
      schema: aiTaskPlanSchema,
      system: [
        'You are Helm\'s task planner for a local computer-use agent.',
        'Convert the user request into one concrete goal and explicit, deterministic completion criteria.',
        'Use only criteria that Helm can verify: browser.url, file.exists, file.contains, window.open, or window.focused.',
        'Do not invent success. The runtime owns actions, verification, retries, and completion.',
        'Keep the goal concise and do not include private chain-of-thought.',
      ].join(' '),
      prompt: JSON.stringify({
        threadId: input.threadId,
        userRequest: input.userMessage,
        criterionTypes: [
          'browser.url',
          'file.exists',
          'file.contains',
          'window.open',
          'window.focused',
        ],
      }, null, 2),
    });

    return {
      id: `ai-task-${input.threadId}`,
      threadId: input.threadId,
      goal: plan.goal,
      criteria: plan.criteria as CompletionCriterion[],
      ...(plan.maxSteps === undefined ? {} : { maxSteps: plan.maxSteps }),
    };
  }
}

export class AiSdkThreadTitleGenerator {
  constructor(public readonly options: AiSdkThreadTitleGeneratorOptions) {}

  async generate(input: string): Promise<string> {
    const fallback = fallbackThreadTitle(input);
    try {
      const result = await generateStructured({
        model: this.options.model,
        maxOutputTokens: this.options.maxOutputTokens,
        temperature: this.options.temperature,
        requestTimeoutMs: this.options.requestTimeoutMs,
        schema: aiThreadTitleSchema,
        system: [
          'You generate concise conversation titles for Helm.',
          'Return a short human-readable title for the user request, not a sentence or explanation.',
          'Use at most 80 characters, preserve the user intent, and do not use markdown or quotation marks.',
        ].join(' '),
        prompt: `User request:\n${promptJson(input, 8_000)}`,
      });
      const title = result.title.trim().replace(/\s+/gu, ' ');
      return title.length > 0 ? title.slice(0, MAX_THREAD_TITLE_LENGTH).trimEnd() : fallback;
    } catch {
      return fallback;
    }
  }
}

export interface AiSdkEmbeddingProviderOptions {
  model: EmbeddingModel;
  dimensions: number;
  requestTimeoutMs: number;
}

export class AiSdkEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(public readonly options: AiSdkEmbeddingProviderOptions) {
    if (!Number.isInteger(options.dimensions) || options.dimensions < 1) {
      throw new RangeError('Embedding dimensions must be a positive integer');
    }
    this.dimensions = options.dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const result = await embed({
      model: this.options.model,
      value: text,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(this.options.requestTimeoutMs),
    });
    if (result.embedding.length !== this.dimensions) {
      throw new RangeError(
        `Embedding model returned ${result.embedding.length} dimensions; expected ${this.dimensions}`,
      );
    }
    return new Float32Array(result.embedding);
  }
}
