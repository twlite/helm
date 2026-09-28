import { generateText, isStepCount, modelMessageSchema, Output, tool, ToolLoopAgent, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { JsonValue, Message, ModelRequestOutcome, RunDiagnostics, ToolResult, VerificationResult } from '@helm/shared';

import type { ActingAgentContext, ActingAgentProvider, ActingAgentResult } from '../agent/types';
import type { ToolDefinition } from '../tools/registry';
import {
  groupConversation,
  prepareModelContext,
  contextSummarySchema,
  type ContextBudgetOptions,
  type ContextExchange,
} from './context-manager';
import { structuredOutputSchema, type StructuredOutputCompatibility } from './structured-output';

const BASE_INSTRUCTIONS = [
  'You are Helm, a computer-use assistant.',
  'Use the provided tools when the task requires browser, filesystem, desktop, application, or memory actions.',
  'You decide the sequence of actions. Use actual tool results. If a tool fails, inspect the error and recover.',
  'Do not claim that an external action succeeded unless a tool returned success.',
  'A URL included as data for an artifact is not automatically a browser destination.',
  'Prefer semantic browser tools for page reading because they are compact. browser.read query is natural-language content relevance text, never a CSS selector; use browser.query for DOM/CSS inspection. Check table counts and row counts, use blockTypes to select a structured block class such as table when appropriate, and use mode document when several relevant blocks should be exported together.',
  'For page-derived raw data, pass a returned durable block ref or documentRef directly to fs.write sourceRef; no additional browser.read is needed. For a summary or other transformation, write your model-authored result with fs.write content.',
  'Use app.launch only when the user asks to start an application without a file. Use app.openFile for an existing file; it checks the file and launches the selected application if needed.',
  'Finish with a normal concise assistant response only after the user\'s requested task is complete.',
].join(' ');

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function parseDiagnosticInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value) as unknown; } catch { return value; }
}

function boundedDiagnosticInput(
  value: unknown,
  key = '',
  depth = 0,
  budget = { nodes: 120, chars: 4_000 },
): JsonValue | undefined {
  if (budget.nodes <= 0) return '[additional input omitted]';
  budget.nodes -= 1;
  if (depth > 5) return '[nested input omitted]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') {
    if (/password|secret|cookie|authorization|api[_-]?key|credential|base64/iu.test(key)) return '[redacted]';
    const limit = Math.min(budget.chars, /content|text|body|data/iu.test(key) ? 240 : 600);
    budget.chars -= Math.min(value.length, limit);
    return value.length > limit ? `${value.slice(0, limit)}… [${value.length} characters]` : value;
  }
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    for (const item of value.slice(0, 16)) {
      if (budget.nodes <= 0 || budget.chars <= 0) {
        output.push('[additional input omitted]');
        break;
      }
      output.push(boundedDiagnosticInput(item, key, depth + 1, budget) ?? null);
    }
    return output;
  }
  const source = record(value);
  if (!source) return undefined;
  const output: Record<string, JsonValue> = {};
  for (const [childKey, child] of Object.entries(source).slice(0, 24)) {
    if (budget.nodes <= 0 || budget.chars <= 0) {
      output._omitted = true;
      break;
    }
    const safe = boundedDiagnosticInput(child, childKey.slice(0, 80), depth + 1, budget);
    if (safe !== undefined) output[childKey.slice(0, 80)] = safe;
  }
  if (Object.keys(source).length > 24) output._omittedKeys = Object.keys(source).length - 24;
  return output;
}

function toolCallInput(call: unknown): JsonValue | undefined {
  const value = record(call);
  const raw = value?.input ?? value?.args ?? value?.rawInput;
  return boundedDiagnosticInput(parseDiagnosticInput(raw));
}

function validationIssues(value: unknown): NonNullable<NonNullable<ModelRequestOutcome['toolCalls']>[number]['validationIssues']> | undefined {
  const candidate = Array.isArray(value) ? value : record(value)?.issues;
  if (!Array.isArray(candidate)) return undefined;
  const issues = candidate.slice(0, 8).flatMap(item => {
    const issue = record(item);
    if (!issue) return [];
    const path = Array.isArray(issue.path)
      ? issue.path.slice(0, 8).filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
      : [];
    const code = typeof issue.code === 'string' ? issue.code.slice(0, 80) : 'invalid_input';
    const message = typeof issue.message === 'string' ? issue.message.slice(0, 400) : 'Input did not match the tool schema.';
    return [{ path, code, message }];
  });
  return issues.length > 0 ? issues : undefined;
}

function issuesFromFailure(value: unknown): NonNullable<NonNullable<ModelRequestOutcome['toolCalls']>[number]['validationIssues']> | undefined {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length > 0 && visited.size < 6) {
    const error = record(pending.shift());
    if (!error || visited.has(error)) continue;
    visited.add(error);
    const issues = validationIssues(error.issues ?? error.validationIssues ?? error.details);
    if (issues) return issues;
    for (const key of ['cause', 'validationError']) {
      const nested = error[key];
      if (nested && typeof nested === 'object') pending.push(nested);
    }
  }
  return undefined;
}

function errorDiagnostic(caught: unknown): Pick<ModelRequestOutcome, 'errorName' | 'errorCode'> {
  const value = record(caught);
  return {
    ...(caught instanceof Error ? { errorName: caught.name } : typeof value?.name === 'string' ? { errorName: value.name } : {}),
    ...(typeof value?.code === 'string' ? { errorCode: value.code } : {}),
  };
}

function diagnosticToolCalls(
  result: Awaited<ReturnType<ToolLoopAgent<never, ToolSet>['generate']>>,
  availableTools: ReadonlySet<string>,
): NonNullable<ModelRequestOutcome['toolCalls']> {
  const calls: NonNullable<ModelRequestOutcome['toolCalls']> = [];
  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      const failedPart = step.content.find(part => part.type === 'tool-error' && part.toolCallId === call.toolCallId);
      if (!availableTools.has(call.toolName)) {
        calls.push({ tool: call.toolName, outcome: 'rejected-before-execution', errorCode: 'UNKNOWN_TOOL' });
        continue;
      }
      if (call.dynamic === true && call.invalid === true) {
        const failedPart = step.content.find(part => part.type === 'tool-error' && part.toolCallId === call.toolCallId);
        const failure = record(call)?.error ?? record(record(failedPart)?.error);
        const issues = issuesFromFailure(failure);
        calls.push({
          tool: call.toolName,
          outcome: 'schema-validation-failed',
          errorCode: 'INVALID_INPUT',
          ...(toolCallInput(call) ? { input: toolCallInput(call) } : {}),
          ...(issues ? { validationIssues: issues } : {}),
        });
        continue;
      }
      const toolResult = step.toolResults.find(item => item.toolCallId === call.toolCallId);
      const output = record(toolResult?.output);
      const error = record(output?.error);
      const errorCode = typeof error?.code === 'string' ? error.code : undefined;
      if (errorCode === 'INVALID_INPUT') {
        const issues = validationIssues(error?.details);
        calls.push({
          tool: call.toolName,
          outcome: 'schema-validation-failed',
          errorCode,
          ...(toolCallInput(call) ? { input: toolCallInput(call) } : {}),
          ...(issues ? { validationIssues: issues } : {}),
        });
      } else if (errorCode === 'ACTION_BUDGET_EXCEEDED' || errorCode === 'REPEATED_ACTION' || errorCode === 'UNKNOWN_TOOL') {
        calls.push({ tool: call.toolName, outcome: 'rejected-before-execution', errorCode });
      } else if (output && typeof output.ok === 'boolean') {
        calls.push({
          tool: call.toolName,
          outcome: output.ok ? 'succeeded' : 'failed',
          ...(errorCode ? { errorCode } : {}),
        });
      } else if (failedPart) {
        const failure = record(record(failedPart)?.error);
        const name = typeof failure?.name === 'string' ? failure.name : '';
        if (name.includes('NoSuchTool')) {
          calls.push({ tool: call.toolName, outcome: 'rejected-before-execution', errorCode: 'UNKNOWN_TOOL' });
        } else {
          calls.push({
            tool: call.toolName,
            outcome: name.includes('InvalidToolInput') ? 'schema-validation-failed' : 'failed',
            ...(typeof failure?.code === 'string' ? { errorCode: failure.code } : {}),
            ...(name.includes('InvalidToolInput') && toolCallInput(call) ? { input: toolCallInput(call) } : {}),
            ...(name.includes('InvalidToolInput') && issuesFromFailure(failure) ? { validationIssues: issuesFromFailure(failure) } : {}),
          });
        }
      } else {
        calls.push({ tool: call.toolName, outcome: 'no-result' });
      }
    }
  }
  return calls;
}

function actingTurnOutcome(
  request: number,
  result: Awaited<ReturnType<ToolLoopAgent<never, ToolSet>['generate']>>,
  providerCalls: number,
  availableTools: ReadonlySet<string>,
): ModelRequestOutcome {
  const toolCalls = diagnosticToolCalls(result, availableTools);
  const hasText = result.text.trim().length > 0;
  return {
    request,
    kind: 'acting-turn',
    providerCalls,
    providerRetries: Math.max(0, providerCalls - 1),
    outcome: toolCalls.length > 0
      ? hasText ? 'assistant-text-and-tool-call' : 'tool-call'
      : hasText ? 'assistant-text' : 'no-actionable-output',
    finishReason: result.finishReason,
    toolCalls,
  };
}

function thrownToolCallDiagnostic(caught: unknown): ModelRequestOutcome['toolCalls'] {
  const value = record(caught);
  const name = caught instanceof Error ? caught.name : typeof value?.name === 'string' ? value.name : '';
  const toolName = typeof value?.toolName === 'string' ? value.toolName : undefined;
  if (!toolName) return undefined;
  if (name.includes('NoSuchTool')) {
    return [{ tool: toolName, outcome: 'rejected-before-execution', errorCode: 'UNKNOWN_TOOL' }];
  }
  if (name.includes('InvalidToolInput')) {
    return [{ tool: toolName, outcome: 'schema-validation-failed', errorCode: 'INVALID_INPUT' }];
  }
  return undefined;
}

function instructionsFor(input: ActingAgentContext): string {
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
  return `${BASE_INSTRUCTIONS}${memoryInstructions}`;
}

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
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const definition of definitions) {
    const inputSchema = definition.inputSchema ?? definition.schema;
    if (!inputSchema) throw new Error(`Missing input schema for Helm tool ${definition.name}`);
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema,
      execute: input => executeTool(definition.name, input as Record<string, unknown>),
    });
  }
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

const MAX_FINALIZATION_TURNS = 2;

function flattenExchanges(exchanges: readonly ContextExchange[]): ModelMessage[] {
  return exchanges.flatMap(exchange => exchange.messages);
}

function assertModelMessages(messages: readonly ModelMessage[], source: string): void {
  const validation = modelMessageSchema.array().safeParse(messages);
  if (validation.success) return;

  const issues = validation.error.issues.slice(0, 8).map(issue => (
    `${JSON.stringify(issue.path)} ${issue.code}: ${issue.message}`
  ));
  throw new Error(`${source} failed ModelMessage[] validation: ${issues.join('; ')}`);
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

export class ActingAgentExecutionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: RunDiagnostics,
  ) {
    super(message);
    this.name = 'ActingAgentExecutionError';
  }
}

/** Runs one coherent conversation with native SDK tool calls and bounded continuation. */
export class AiSdkActingAgent implements ActingAgentProvider {
  constructor(public readonly options: AiSdkActingAgentOptions) {}

  async execute(input: ActingAgentContext): Promise<ActingAgentResult> {
    let exchanges = groupConversation(asModelMessages(input.conversation, input.userMessage), input.userMessage);
    let acceptedResponse: string | undefined;
    let acceptedVerification: ActingAgentResult['verification'] | undefined;
    let lastVerification: VerificationResult | undefined;
    let lastRejectedResponse: string | undefined;
    let completionRecoveryTurns = 0;
    let lastRejectedCompletion: string | undefined;
    let compactionCount = 0;
    const instructions = instructionsFor(input);
    const budget = contextBudget(this.options.contextBudget);
    const diagnostics: RunDiagnostics = {
      modelTurns: 0,
      modelRequests: 0,
      toolActions: 0,
      completionAttempts: 0,
      completionRejections: 0,
      contextCompactions: 0,
      finalizationTurns: 0,
      lastUnsatisfiedRequirements: [],
      modelRequestOutcomes: [],
    };

    const refreshUnsatisfied = (): void => {
      diagnostics.lastUnsatisfiedRequirements = input.getRequirementSummary()
        .split('\n')
        .filter(line => /\[(?:pending|blocked)\]/u.test(line))
        .map(line => line.trim());
    };
    const emitDiagnostics = async (): Promise<void> => {
      refreshUnsatisfied();
      diagnostics.toolActions = input.getToolActionCount?.() ?? diagnostics.toolActions;
      await input.onDiagnostics?.({
        ...diagnostics,
        lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements],
        modelRequestOutcomes: diagnostics.modelRequestOutcomes?.map(item => ({
          ...item,
          ...(item.toolCalls ? { toolCalls: item.toolCalls.map(call => ({ ...call })) } : {}),
        })),
      });
    };

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
          diagnostics.modelRequests += 1;
          diagnostics.contextCompactions += 1;
          const request = diagnostics.modelRequests;
          let providerCalls = 0;
          let providerReturned = false;
          await emitDiagnostics();
          try {
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
              onLanguageModelCallStart: () => { providerCalls += 1; },
            });
            providerReturned = true;
            const output = contextSummarySchema.parse(summarized.output);
            diagnostics.modelRequestOutcomes?.push({
              request,
              kind: 'context-compaction',
              providerCalls,
              providerRetries: Math.max(0, providerCalls - 1),
              outcome: 'context-summary',
              finishReason: summarized.finishReason,
            });
            await emitDiagnostics();
            return output;
          } catch (caught) {
            diagnostics.modelRequestOutcomes?.push({
              request,
              kind: 'context-compaction',
              providerCalls,
              providerRetries: Math.max(0, providerCalls - 1),
              outcome: providerReturned ? 'context-summary-error' : 'provider-error',
              ...errorDiagnostic(caught),
            });
            await emitDiagnostics();
            throw caught;
          }
        },
      });
      exchanges = result.exchanges;
      compactionCount = result.usage.compactions;
      await input.onContextUsage?.(result.usage);
      if (result.compaction) await input.onContextCompacted?.(result.compaction);
      const messages = flattenExchanges(exchanges);
      assertModelMessages(messages, 'Prepared acting-agent context');
      return messages;
    };

    const verifyResponse = async (responseValue: string): Promise<ToolResult<VerificationResult>> => {
      const response = responseValue.trim();
      if (!response) return { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'A non-empty final response is required.' } };
      diagnostics.completionAttempts += 1;
      const checked = await input.verifyCompletion({ response });
      if (checked.data) lastVerification = checked.data;
      if (checked.ok && checked.data?.complete) {
        acceptedResponse = response;
        acceptedVerification = checked.data;
      } else {
        diagnostics.completionRejections += 1;
      }
      const latestOutcome = diagnostics.modelRequestOutcomes?.at(-1);
      if ((latestOutcome?.kind === 'acting-turn' || latestOutcome?.kind === 'finalization')
        && latestOutcome.request === diagnostics.modelRequests) {
        latestOutcome.completion = checked.ok && checked.data?.complete ? 'accepted' : 'rejected';
      }
      await emitDiagnostics();
      return checked;
    };

    const tools = modelToolSet(input.toolDefinitions, input.executeTool);
    const toolContext = toolDefinitionsDescription(input.toolDefinitions);
    const maxModelTurns = Math.max(1, Math.trunc(input.maxModelTurns));
    const maxCompletionRecoveryTurns = Math.max(0, Math.trunc(input.maxCompletionRecoveryTurns));

    const effectsAreVerified = (): boolean => {
      const current = input.getCurrentVerification?.();
      if (current) return current.complete;
      const requirementSummary = input.getRequirementSummary();
      if (requirementSummary.trim()) {
        return !requirementSummary.split('\n').some(line => /\[(?:pending|blocked)\]/u.test(line));
      }
      return lastVerification?.complete ?? true;
    };

    const acceptedResult = (): ActingAgentResult => ({
      response: acceptedResponse!,
      verification: acceptedVerification!,
      diagnostics: { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
    });

    const finalize = async (): Promise<ActingAgentResult> => {
      if (effectsAreVerified() && lastRejectedResponse) {
        const checked = await verifyResponse(lastRejectedResponse);
        if (checked.ok && checked.data?.complete && acceptedResponse && acceptedVerification) return acceptedResult();
      }
      if (!effectsAreVerified()) {
        throw new ActingAgentExecutionError(
          'FINALIZATION_VERIFICATION_FAILED',
          'Finalization was skipped because deterministic verification no longer reports the requested effects as complete.',
          { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
        );
      }

      exchanges.push({
        kind: 'conversation',
        messages: [{
          role: 'user',
          content: [
            'The runtime has verified that the requested effects are complete.',
            'Provide a concise, natural final response to the user. Do not call tools or suggest more actions.',
            `Verification: ${JSON.stringify(input.getCurrentVerification?.() ?? lastVerification ?? { complete: true })}`,
          ].join('\n'),
        }],
      });
      const finalInstructions = `${instructions} All requested external effects have already been verified. This is a response-only finalization turn; do not claim anything beyond the conversation and verification evidence.`;

      for (let finalizationIndex = 0; finalizationIndex < MAX_FINALIZATION_TURNS; finalizationIndex += 1) {
        if (input.signal?.aborted) throw input.signal.reason ?? new Error('Agent run cancelled');
        if (finalizationIndex > 0) {
          exchanges.push({
            kind: 'conversation',
            messages: [{ role: 'user', content: 'Return a non-empty concise final response for the completed task.' }],
          });
        }
        const messages = await prepare(finalInstructions, 'No tools are available during finalization.');
        let providerCalls = 0;
        diagnostics.finalizationTurns = (diagnostics.finalizationTurns ?? 0) + 1;
        diagnostics.modelRequests += 1;
        const request = diagnostics.modelRequests;
        await emitDiagnostics();
        try {
          const result = await generateText({
            model: this.options.model,
            system: finalInstructions,
            messages,
            maxOutputTokens: this.options.maxOutputTokens,
            temperature: this.options.temperature,
            timeout: this.options.requestTimeoutMs,
            maxRetries: 0,
            abortSignal: input.signal,
            onLanguageModelCallStart: () => { providerCalls += 1; },
          });
          diagnostics.modelRequestOutcomes?.push({
            request,
            kind: 'finalization',
            providerCalls,
            providerRetries: Math.max(0, providerCalls - 1),
            outcome: result.text.trim() ? 'final-response' : 'finalization-error',
            finishReason: result.finishReason,
            ...(!result.text.trim() ? { errorCode: 'EMPTY_RESPONSE' } : {}),
          });
          if (result.response.messages.length > 0) {
            exchanges.push({ messages: result.response.messages, kind: 'conversation' });
          }
          await emitDiagnostics();
          const response = result.text.trim();
          if (!response) continue;
          const checked = await verifyResponse(response);
          if (checked.ok && checked.data?.complete && acceptedResponse && acceptedVerification) return acceptedResult();
          if (!effectsAreVerified()) {
            throw new ActingAgentExecutionError(
              'FINALIZATION_VERIFICATION_FAILED',
              'The requested effects became incomplete while finalizing the response.',
              { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
            );
          }
        } catch (caught) {
          if (caught instanceof ActingAgentExecutionError) throw caught;
          diagnostics.modelRequestOutcomes?.push({
            request,
            kind: 'finalization',
            providerCalls,
            providerRetries: Math.max(0, providerCalls - 1),
            outcome: 'finalization-error',
            ...errorDiagnostic(caught),
          });
          await emitDiagnostics();
        }
      }

      await emitDiagnostics();
      throw new ActingAgentExecutionError(
        'FINALIZATION_FAILED',
        'The requested effects are verified, but the acting model did not produce a valid final response within the bounded finalization budget.',
        { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
      );
    };

    while (diagnostics.modelTurns < maxModelTurns) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Agent run cancelled');

      const steering = input.drainSteering?.() ?? [];
      if (steering.length > 0) exchanges.push({ messages: toModelMessages(steering), kind: 'conversation' });

      const currentInstructions = instructions;
      const messages = await prepare(currentInstructions, toolContext);
      let providerCalls = 0;

      const agent = new ToolLoopAgent<never, ToolSet>({
        model: this.options.model,
        instructions: currentInstructions,
        tools,
        toolChoice: 'auto',
        stopWhen: isStepCount(1),
        maxOutputTokens: this.options.maxOutputTokens,
        temperature: this.options.temperature,
        timeout: this.options.requestTimeoutMs,
        maxRetries: 0,
        onLanguageModelCallStart: () => { providerCalls += 1; },
      });
      diagnostics.modelTurns += 1;
      diagnostics.modelRequests += 1;
      const request = diagnostics.modelRequests;
      await emitDiagnostics();
      let result: Awaited<ReturnType<typeof agent.generate>>;
      try {
        result = await agent.generate({
          messages,
          abortSignal: input.signal,
          timeout: this.options.requestTimeoutMs,
        });
      } catch (caught) {
        const toolCalls = thrownToolCallDiagnostic(caught);
        diagnostics.modelRequestOutcomes?.push({
          request,
          kind: 'acting-turn',
          providerCalls,
          providerRetries: Math.max(0, providerCalls - 1),
          outcome: toolCalls ? 'tool-call' : 'provider-error',
          ...(toolCalls ? { toolCalls } : {}),
          ...errorDiagnostic(caught),
        });
        await emitDiagnostics();
        throw caught;
      }
      const turnOutcome = actingTurnOutcome(
        request,
        result,
        providerCalls,
        new Set(input.toolDefinitions.map(definition => definition.name)),
      );
      diagnostics.modelRequestOutcomes?.push(turnOutcome);
      await emitDiagnostics();
      assertModelMessages(result.responseMessages, 'Acting-agent response history');
      exchanges.push({ messages: result.responseMessages, kind: 'tool' });

      if (turnOutcome.toolCalls?.length) lastRejectedCompletion = undefined;

      if (acceptedResponse !== undefined && acceptedVerification !== undefined) {
        await emitDiagnostics();
        return {
          response: acceptedResponse,
          verification: acceptedVerification,
          diagnostics: { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
        };
      }

      if (turnOutcome.outcome === 'no-actionable-output') {
        await emitDiagnostics();
        throw new ActingAgentExecutionError(
          'NO_ACTIONABLE_OUTPUT',
          'The acting model returned no assistant text or tool call. The runtime stopped instead of repeating the same request without new information.',
          { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
        );
      }

      const endedWithText = result.text.trim().length > 0 && result.finishReason !== 'tool-calls';
      if (endedWithText) {
        const checked = await verifyResponse(result.text);
        if (checked.ok && checked.data?.complete) {
          await emitDiagnostics();
          return {
            response: acceptedResponse ?? result.text.trim(),
            verification: checked.data,
            diagnostics: { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
          };
        }
        lastRejectedResponse = result.text.trim();
        if (effectsAreVerified()) return finalize();
        const feedback = checked.error?.message ?? 'The runtime has not verified every requested effect.';
        const rejectedCompletion = JSON.stringify([result.text.trim(), feedback]);
        if (rejectedCompletion === lastRejectedCompletion) {
          await emitDiagnostics();
          throw new ActingAgentExecutionError(
            'REPEATED_UNVERIFIED_COMPLETION',
            'The model repeated the same unverified response after receiving the same missing-effects feedback. The runtime stopped instead of spending another turn without new information.',
            { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
          );
        }
        lastRejectedCompletion = rejectedCompletion;
        if (completionRecoveryTurns >= maxCompletionRecoveryTurns) {
          await emitDiagnostics();
          throw new ActingAgentExecutionError(
            'COMPLETION_RECOVERY_BUDGET_EXCEEDED',
            'The model repeatedly proposed a response while requested effects remained unverified.',
            { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
          );
        }
        completionRecoveryTurns += 1;
        exchanges.push({
          kind: 'conversation',
          messages: [{
            role: 'user',
            content: `The task is not complete yet.\n\nMissing requested effects:\n${feedback}\n\nContinue using the available tools.`,
          }],
        });
      }

      if (Boolean(turnOutcome.toolCalls?.length) && effectsAreVerified()) {
        // Some providers return assistant text alongside the final tool call.
        // Let the normal verifier accept that text before spending a separate
        // response-only model request.
        if (result.text.trim()) {
          const checked = await verifyResponse(result.text);
          if (checked.ok && checked.data?.complete && acceptedResponse && acceptedVerification) {
            return acceptedResult();
          }
        }
        await emitDiagnostics();
        return finalize();
      }
      await emitDiagnostics();
    }

    if (effectsAreVerified()) return finalize();

    await emitDiagnostics();
    const unsatisfied = diagnostics.lastUnsatisfiedRequirements.length > 0
      ? 'before all requested effects were verified.'
      : 'before deterministic verification was complete.';
    throw new ActingAgentExecutionError(
      'MODEL_TURN_BUDGET_EXCEEDED',
      `The acting model reached its ${maxModelTurns}-turn action/recovery budget ${unsatisfied}`,
      { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
    );
  }
}
