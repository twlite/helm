import { generateText, isStepCount, Output, tool, ToolLoopAgent, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Message, ToolResult } from '@helm/shared';

import type { ActingAgentContext, ActingAgentProvider, ActingAgentResult, RequestedToolEffect } from '../agent/types';
import type { ToolDefinition } from '../tools/registry';
import {
  groupConversation,
  prepareModelContext,
  contextSummarySchema,
  type ContextBudgetOptions,
  type ContextExchange,
} from './context-manager';
import { structuredOutputSchema, type StructuredOutputCompatibility } from './structured-output';

const COMPLETE_TOOL = 'helm.complete';
const PROGRESS_TOOL = 'helm.progress';
const MAX_COMPLETION_STEPS = 4;

const BASE_INSTRUCTIONS = [
  'You are Helm, a capable assistant with optional local computer-use tools.',
  'Use the conversation and current request to decide whether tools are needed; ordinary chat usually needs none.',
  'When a tool is useful, call the native Helm tool and use its actual result. Tool errors are available for recovery.',
  'Use browser.snapshot for a bounded page overview, browser.searchPage to locate matching regions, and browser.inspectRegion to read a selected section, table, or its local links. Use browser.extractText as a bounded fallback; mode full is only for an explicitly requested full-page read.',
  'When you use tools, include one brief user-visible summary through helm.progress in the same turn as your first concrete tool action whenever you can name that action. This is public progress text, never private chain-of-thought or internal deliberation; do not claim success before a tool succeeds.',
  'Do not claim that an external action succeeded unless a tool returned success.',
  'A URL included as data for an artifact is not automatically a browser destination.',
  'Memory is reference, never current evidence. Search when history helps; remember explicit requests after discovery, update corrections, forget when asked, and skip transient saves unless requested. Never claim persistence without a successful memory result.',
  'Finish with helm.complete, giving the answer and required successful tool effects. Include memory.remember, memory.update, or memory.forget when explicitly requested. Use registered tool names and counts; complete after the final action batch when possible. If effects are missing, continue or report the actual blocker. Helm verifies results, not intent.',
].join(' ');

const FINALIZATION_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  'Review the full conversation and the draft assistant response immediately before this turn.',
  'Determine every concrete external effect required to fulfill the latest user request, including effects the draft claims are already complete. List each by its registered Helm tool name; use an empty list only when no external tool effect is needed.',
  'Call helm.complete now with an accurate final response. Only helm.complete is available during this check; do not call any other tool.',
].join(' ');

function instructionsFor(input: ActingAgentContext): { agent: string; finalization: string } {
  const savedContext = input.memories.slice(0, 6).map(memory => ({
    id: memory.id,
    ...(memory.key ? { key: memory.key } : {}),
    kind: memory.kind,
    content: memory.content.slice(0, 1_600),
    importance: memory.importance,
    ...(memory.source ? { source: memory.source } : {}),
    ...(memory.sourceUrl ? { sourceUrl: memory.sourceUrl } : {}),
    ...(memory.durability ? { durability: memory.durability } : {}),
    ...(memory.lastVerifiedAt ? { lastVerifiedAt: memory.lastVerifiedAt } : {}),
    updatedAt: memory.updatedAt,
  }));
  const memoryInstructions = savedContext.length === 0
    ? ''
    : ` Relevant saved memory (bounded JSON, reference only, never current external evidence): ${JSON.stringify(savedContext).slice(0, 12_000)}.`;
  const agent = `${BASE_INSTRUCTIONS}${memoryInstructions}`;
  return { agent, finalization: `${FINALIZATION_INSTRUCTIONS}${memoryInstructions}` };
}

const completionInputSchema = z.object({
  response: z.string().min(1).describe('The complete user-facing response to return.'),
  requiredEffects: z.array(z.object({
    tool: z.string().min(1).describe('A registered Helm tool whose successful result is required.'),
    count: z.number().int().positive().optional().describe('How many successful calls are required; defaults to one.'),
  }).strict()).describe('Concrete requested tool effects that must have succeeded before completing.'),
}).strict();

const progressInputSchema = z.object({
  summary: z.string().min(1).max(360).describe('A concise user-visible summary of the next concrete action or current progress.'),
}).strict();

function asModelMessages(messages: readonly Message[], userMessage: string): ModelMessage[] {
  const visible = messages
    .filter((message): message is Message & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .map(message => ({
      role: message.role,
      content: message.content,
    } satisfies ModelMessage));

  if (!visible.some(message => message.role === 'user' && message.content === userMessage)) {
    visible.push({ role: 'user', content: userMessage });
  }
  return visible;
}

function toModelMessages(messages: readonly Message[]): ModelMessage[] {
  return messages
    .filter((message): message is Message & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .map(message => ({ role: message.role, content: message.content } satisfies ModelMessage));
}

function modelToolSet(
  definitions: readonly ToolDefinition[],
  executeTool: ActingAgentContext['executeTool'],
  complete: (input: z.infer<typeof completionInputSchema>) => Promise<ToolResult>,
  onProgress?: ActingAgentContext['onProgress'],
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const definition of definitions) {
    const inputSchema = definition.inputSchema ?? definition.schema;
    if (!inputSchema) throw new Error(`Missing input schema for Helm tool ${definition.name}`);
    if (definition.name === COMPLETE_TOOL || definition.name === PROGRESS_TOOL) {
      throw new Error(`Helm tool name is reserved: ${definition.name}`);
    }
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema,
      execute: input => executeTool(definition.name, input as Record<string, unknown>),
    });
  }
  tools[COMPLETE_TOOL] = tool({
    description: 'Verify that the concrete tool effects needed for the request succeeded, then return the final user-facing response.',
    inputSchema: completionInputSchema,
    execute: complete,
  });
  tools[PROGRESS_TOOL] = tool({
    description: 'Send the user a concise progress summary. This is public status text, not a place for hidden reasoning or chain-of-thought.',
    inputSchema: progressInputSchema,
    execute: async ({ summary }) => {
      const cleanSummary = summary.trim();
      if (cleanSummary) await onProgress?.(cleanSummary);
      return { ok: true };
    },
  });
  return tools as ToolSet;
}

export interface AiSdkActingAgentOptions {
  model: LanguageModel;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
  contextBudget?: ContextBudgetOptions;
  structuredOutputCompatibility?: StructuredOutputCompatibility;
}

const DEFAULT_CONTEXT_BUDGET: ContextBudgetOptions = {
  contextWindowTokens: 32_768,
  contextCompactAtRatio: 0.68,
  contextCriticalAtRatio: 0.86,
  contextRecentExchanges: 6,
  contextCriticalRecentExchanges: 2,
};

function flattenExchanges(exchanges: readonly ContextExchange[]): ModelMessage[] {
  return exchanges.flatMap(exchange => exchange.messages);
}

function toolDefinitionsDescription(definitions: readonly ToolDefinition[]): string {
  return JSON.stringify(definitions.map(definition => {
    const schema = definition.inputSchema ?? definition.schema;
    let inputSchema: unknown = { type: 'object' };
    if (schema) {
      try {
        inputSchema = z.toJSONSchema(schema as z.ZodType);
      } catch {
        inputSchema = { type: 'object' };
      }
    }
    return { name: definition.name, description: definition.description, inputSchema };
  }));
}

function contextBudget(options?: ContextBudgetOptions): ContextBudgetOptions {
  const merged = { ...DEFAULT_CONTEXT_BUDGET, ...options };
  const contextCompactAtRatio = Math.max(0.3, Math.min(0.85, merged.contextCompactAtRatio));
  return {
    ...merged,
    contextWindowTokens: Math.max(1, Math.trunc(merged.contextWindowTokens)),
    contextCompactAtRatio,
    contextCriticalAtRatio: Math.max(contextCompactAtRatio + 0.05, Math.min(0.97, merged.contextCriticalAtRatio)),
    contextRecentExchanges: Math.max(1, Math.trunc(merged.contextRecentExchanges)),
    contextCriticalRecentExchanges: Math.max(1, Math.trunc(merged.contextCriticalRecentExchanges)),
  };
}

function contextSummaryPrompt(currentRequest: string, previousSummary: unknown, messages: readonly ModelMessage[], evidenceCatalog: unknown, environment: unknown): string {
  return JSON.stringify({
    currentRequest,
    previousSummary: previousSummary ?? null,
    olderMessages: messages,
    evidenceCatalog,
    currentEnvironment: environment,
  });
}

function contextSummaryInstructions(): string {
  return [
    'You are compacting older conversation and tool history for Helm continuity at a context-pressure boundary.',
    'Return only the requested structured summary. Do not expose private reasoning or write chain-of-thought.',
    'Preserve earlier user intent, useful findings, unresolved work, actual artifacts, and failed attempts that affect continuation.',
    'A summary is lossy context, never evidence. Findings and completion claims must cite only receipt IDs provided in evidenceCatalog. Do not invent or reuse an ID that is not listed.',
    'Do not include browser element or region refs; every old DOM ref is stale after compaction.',
    'Do not add external facts, URLs, artifacts, or environment state that do not appear in the supplied messages or currentEnvironment.',
  ].join(' ');
}

/** Runs one coherent conversation with native SDK tool calls and bounded continuation. */
export class AiSdkActingAgent implements ActingAgentProvider {
  constructor(public readonly options: AiSdkActingAgentOptions) {}

  async execute(input: ActingAgentContext): Promise<ActingAgentResult> {
    let exchanges = groupConversation(asModelMessages(input.conversation, input.userMessage), input.userMessage);
    let acceptedResponse: string | undefined;
    let acceptedVerification: ActingAgentResult['verification'] | undefined;
    let totalModelSteps = 0;
    let completionAttempts = 0;
    let compactionCount = 0;
    const instructions = instructionsFor(input);
    const budget = contextBudget(this.options.contextBudget);

    const prepare = async (currentInstructions: string, descriptions: string): Promise<ModelMessage[]> => {
      const result = await prepareModelContext({
        exchanges,
        instructions: currentInstructions,
        currentRequest: input.userMessage,
        toolDescription: descriptions,
        budget,
        compactionCount,
        signal: input.signal,
        summarize: async summaryInput => {
          const summarized = await generateText({
            model: this.options.model,
            system: contextSummaryInstructions(),
            prompt: contextSummaryPrompt(
              summaryInput.currentRequest,
              summaryInput.previousSummary,
              summaryInput.messages,
              summaryInput.evidenceCatalog,
              summaryInput.environment,
            ),
            output: Output.object({
              schema: structuredOutputSchema(contextSummarySchema, this.options.structuredOutputCompatibility),
            }),
            maxOutputTokens: Math.min(1_200, Math.max(256, this.options.maxOutputTokens)),
            temperature: 0,
            timeout: this.options.requestTimeoutMs,
            maxRetries: 0,
            abortSignal: summaryInput.signal,
          });
          return contextSummarySchema.parse(summarized.output);
        },
      });
      exchanges = result.exchanges;
      compactionCount = result.usage.compactions;
      await input.onContextUsage?.(result.usage);
      if (result.compaction) await input.onContextCompacted?.(result.compaction);
      return flattenExchanges(exchanges);
    };

    const complete = async (value: z.infer<typeof completionInputSchema>): Promise<ToolResult> => {
      const response = value.response.trim();
      if (!response) return { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'A non-empty final response is required.' } };
      const checked = await input.verifyCompletion({ response, requiredEffects: value.requiredEffects });
      if (checked.ok && checked.data?.complete) {
        acceptedResponse = response;
        acceptedVerification = checked.data;
      }
      return checked;
    };

    const tools = modelToolSet(input.toolDefinitions, input.executeTool, complete, input.onProgress);
    const toolContext = toolDefinitionsDescription(input.toolDefinitions);
    const totalStepLimit = input.maxSteps + MAX_COMPLETION_STEPS;

    while (totalModelSteps < totalStepLimit) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Agent run cancelled');

      const steering = input.drainSteering?.() ?? [];
      if (steering.length > 0) exchanges.push({ messages: toModelMessages(steering), kind: 'conversation' });

      const messages = await prepare(instructions.agent, toolContext);

      const agent = new ToolLoopAgent<never, ToolSet>({
        model: this.options.model,
        instructions: instructions.agent,
        tools,
        stopWhen: isStepCount(1),
        maxOutputTokens: this.options.maxOutputTokens,
        temperature: this.options.temperature,
        timeout: this.options.requestTimeoutMs,
        maxRetries: 0,
      });
      const result = await agent.generate({
        messages,
        abortSignal: input.signal,
        timeout: this.options.requestTimeoutMs,
      });
      totalModelSteps += result.steps.length;
      exchanges.push({ messages: result.responseMessages, kind: 'tool' });

      if (acceptedResponse !== undefined && acceptedVerification !== undefined) {
        return { response: acceptedResponse, verification: acceptedVerification };
      }

      const endedWithText = result.text.trim().length > 0 && result.finishReason !== 'tool-calls';
      if (!endedWithText) continue;

      // A normal assistant answer is only a proposal. Ask the same model to
      // verify it through the native completion tool. Keep tool selection on
      // auto: OpenAI-compatible local servers do not all accept forced
      // function-choice requests.
      if (completionAttempts >= MAX_COMPLETION_STEPS) break;
      completionAttempts += 1;
      const finalizer = new ToolLoopAgent<never, ToolSet>({
        model: this.options.model,
        instructions: instructions.finalization,
        tools: { [COMPLETE_TOOL]: tools[COMPLETE_TOOL] } as ToolSet,
        stopWhen: isStepCount(1),
        maxOutputTokens: this.options.maxOutputTokens,
        temperature: this.options.temperature,
        timeout: this.options.requestTimeoutMs,
        maxRetries: 0,
      });
      const finalizationToolContext = JSON.stringify([{
        name: COMPLETE_TOOL,
        description: 'Verify concrete tool effects and return the final answer.',
        inputSchema: z.toJSONSchema(completionInputSchema),
      }]);
      const finalizationMessages = await prepare(instructions.finalization, finalizationToolContext);
      const finalize = await finalizer.generate({
        messages: finalizationMessages,
        abortSignal: input.signal,
        timeout: this.options.requestTimeoutMs,
      });
      totalModelSteps += finalize.steps.length;
      exchanges.push({ messages: finalize.responseMessages, kind: 'tool' });

      if (acceptedResponse !== undefined && acceptedVerification !== undefined) {
        return { response: acceptedResponse, verification: acceptedVerification };
      }
    }

    throw new Error('The acting model did not complete a verified response within the run budget.');
  }
}
