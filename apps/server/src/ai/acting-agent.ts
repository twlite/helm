import { generateText, isStepCount, modelMessageSchema, Output, tool, ToolLoopAgent, type LanguageModel, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Message, RunDiagnostics, ToolResult, VerificationResult } from '@helm/shared';

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

const BLOCKED_TOOL = 'helm.blocked';
const PROGRESS_TOOL = 'helm.progress';

const BASE_INSTRUCTIONS = [
  'You are Helm, a capable assistant with optional local computer-use tools.',
  'Use the conversation and current request to decide whether tools are needed; ordinary chat usually needs none.',
  'When a tool is useful, call the native Helm tool and use its actual result. Tool errors are available for recovery.',
  'When you use tools, include one brief user-visible summary through helm.progress in the same turn as your first concrete tool action whenever you can name that action. This is public progress text, never private chain-of-thought or internal deliberation; do not claim success before a tool succeeds.',
  'Do not claim that an external action succeeded unless a tool returned success.',
  'A URL included as data for an artifact is not automatically a browser destination.',
  'Memory is reference, never current evidence. Search when history helps; remember explicit requests after discovery, update corrections, forget when asked, and skip transient saves unless requested. Never claim persistence without a successful memory result.',
  'Finish with a normal concise assistant response. Helm verifies it against the runtime-compiled requirements; never list or redefine required effects yourself. If an actual tool failure prevents a pending requirement, use helm.blocked with the relevant requirement IDs and an honest user-facing explanation. The runtime checks that failure evidence exists.',
].join(' ');

const PAGE_READING_INSTRUCTIONS = [
  'Use browser.read({ query }) to locate relevant semantic blocks; browser.search ranks the same blocks and exposes observed hrefs. Without a read query, browser.read returns a compact overview. Use browser.read({ ref }) only to inspect more of an already selected block, including table pagination with offset and limit.',
  'When saving extracted page content, choose the relevant block ref and call fs.write with sourceRef and a suitable text, markdown, json, or csv format. The guest transfers the full stored block; do not copy a preview or reconstruct the extracted data in the content argument. Use content for model-authored summaries or other new text.',
  'For an unnamed destination, search DuckDuckGo first and prefer the named organization\'s official result. Never invent a hostname or route. Use an exact user-provided URL directly. When recalled verified memory directly matches the request and supplies a URL, navigate to that exact URL before search discovery; if it fails or unexpectedly redirects, continue with DuckDuckGo. Use browser.open({ ref }) to open a selected result or page link; do not retype or reconstruct its URL.',
  'Before saving page-derived content, obtain a successful non-empty browser.read result. If reading fails, recover with another query or a relevant ref; never save errors or placeholders as the artifact.',
  'An existing output file or already-open window does not satisfy a request to write or open it during this run. Verify the current-run fs.write result before calling app.openFile, and verify the current-run app.openFile result for an explicit open request.',
].join(' ');

function instructionsFor(input: ActingAgentContext): string {
  const canReadPages = input.toolDefinitions.some(definition => definition.name.startsWith('browser.'));
  const coreInstructions = canReadPages
    ? `${BASE_INSTRUCTIONS} ${PAGE_READING_INSTRUCTIONS}`
    : BASE_INSTRUCTIONS;
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
  return `${coreInstructions}${memoryInstructions}`;
}

const blockedInputSchema = z.object({
  response: z.string().trim().min(1).max(2_000).describe('A concise, honest explanation of the blocker for the user.'),
  requirementIds: z.array(z.string().trim().min(1).max(120)).min(1).max(12)
    .describe('Runtime-compiled requirements prevented by an actual failed tool result.'),
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
  reportBlocked: ActingAgentContext['reportBlocked'],
  onBlockedAccepted: (input: z.infer<typeof blockedInputSchema>) => void,
  onProgress?: ActingAgentContext['onProgress'],
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const definition of definitions) {
    const inputSchema = definition.inputSchema ?? definition.schema;
    if (!inputSchema) throw new Error(`Missing input schema for Helm tool ${definition.name}`);
    if (definition.name === BLOCKED_TOOL || definition.name === PROGRESS_TOOL) {
      throw new Error(`Helm tool name is reserved: ${definition.name}`);
    }
    tools[definition.name] = tool({
      description: definition.description,
      inputSchema,
      execute: input => executeTool(definition.name, input as Record<string, unknown>),
    });
  }
  tools[BLOCKED_TOOL] = tool({
    description: 'Finish honestly when an actual failed tool result prevents one or more current requirements. The runtime rejects blocker reports without relevant failure evidence.',
    inputSchema: blockedInputSchema,
    execute: async input => {
      const checked = await reportBlocked(input);
      if (checked.ok && checked.data?.blocked) onBlockedAccepted(input);
      return checked;
    },
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
    let acceptedBlocker: ActingAgentResult['blocked'] | undefined;
    let lastVerification: VerificationResult | undefined;
    let completionRecoveryTurns = 0;
    let blockerRejectionThisTurn = false;
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
      lastUnsatisfiedRequirements: [],
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
      await input.onDiagnostics?.({ ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] });
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
          await emitDiagnostics();
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
      const messages = flattenExchanges(exchanges);
      assertModelMessages(messages, 'Prepared acting-agent context');
      return messages;
    };

    const reportBlocked = async (value: z.infer<typeof blockedInputSchema>): Promise<ToolResult<{ blocked: boolean }>> => {
      const response = value.response.trim();
      if (!response) return { ok: false, error: { code: 'EMPTY_RESPONSE', message: 'A non-empty blocker response is required.' } };
      diagnostics.completionAttempts += 1;
      const checked = await input.reportBlocked({ response, requirementIds: value.requirementIds });
      if (checked.ok && checked.data?.blocked) {
        acceptedBlocker = { response, requirementIds: [...value.requirementIds] };
      } else {
        diagnostics.completionRejections += 1;
        blockerRejectionThisTurn = true;
      }
      await emitDiagnostics();
      return checked;
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
      await emitDiagnostics();
      return checked;
    };

    const tools = modelToolSet(input.toolDefinitions, input.executeTool, reportBlocked, value => {
      acceptedBlocker = { response: value.response, requirementIds: [...value.requirementIds] };
    }, input.onProgress);
    const toolContext = `${toolDefinitionsDescription(input.toolDefinitions)}\nhelm.progress: concise public status; helm.blocked: report a blocker only with relevant failed tool evidence.`;
    const maxModelTurns = Math.max(1, Math.trunc(input.maxModelTurns));
    const maxCompletionRecoveryTurns = Math.max(0, Math.trunc(input.maxCompletionRecoveryTurns));

    while (diagnostics.modelTurns < maxModelTurns) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Agent run cancelled');

      const steering = input.drainSteering?.() ?? [];
      if (steering.length > 0) exchanges.push({ messages: toModelMessages(steering), kind: 'conversation' });

      const requirementSummary = input.getRequirementSummary().trim();
      const currentInstructions = [
        instructions,
        `Task goal: ${input.task.goal}`,
        requirementSummary
          ? `Current runtime-verified requirements:\n${requirementSummary}`
          : 'No external effects are required by the compiled task.',
        'The runtime requirement state is authoritative. Continue acting while a mandatory requirement is pending; do not repeat it as a model-authored effect list.',
      ].join('\n\n');
      const messages = await prepare(currentInstructions, toolContext);
      blockerRejectionThisTurn = false;

      const agent = new ToolLoopAgent<never, ToolSet>({
        model: this.options.model,
        instructions: currentInstructions,
        tools,
        stopWhen: isStepCount(1),
        maxOutputTokens: this.options.maxOutputTokens,
        temperature: this.options.temperature,
        timeout: this.options.requestTimeoutMs,
        maxRetries: 0,
      });
      diagnostics.modelTurns += 1;
      diagnostics.modelRequests += 1;
      await emitDiagnostics();
      const result = await agent.generate({
        messages,
        abortSignal: input.signal,
        timeout: this.options.requestTimeoutMs,
      });
      assertModelMessages(result.responseMessages, 'Acting-agent response history');
      exchanges.push({ messages: result.responseMessages, kind: 'tool' });

      if (blockerRejectionThisTurn) {
        if (completionRecoveryTurns >= maxCompletionRecoveryTurns) {
          await emitDiagnostics();
          throw new ActingAgentExecutionError(
            'COMPLETION_RECOVERY_BUDGET_EXCEEDED',
            'The model repeatedly reported blockers without matching failed action evidence.',
            { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
          );
        }
        completionRecoveryTurns += 1;
      }

      if (acceptedBlocker) {
        await emitDiagnostics();
        return {
          response: acceptedBlocker.response,
          verification: lastVerification ?? { complete: false, criteria: [], requirements: [], summary: 'Run blocked by a verified tool failure.' },
          diagnostics: { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
          blocked: acceptedBlocker,
        };
      }
      if (acceptedResponse !== undefined && acceptedVerification !== undefined) {
        await emitDiagnostics();
        return {
          response: acceptedResponse,
          verification: acceptedVerification,
          diagnostics: { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
        };
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
        if (completionRecoveryTurns >= maxCompletionRecoveryTurns) {
          await emitDiagnostics();
          throw new ActingAgentExecutionError(
            'COMPLETION_RECOVERY_BUDGET_EXCEEDED',
            'The model repeatedly proposed a response while compiled requirements remained unsatisfied.',
            { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
          );
        }
        completionRecoveryTurns += 1;
        const feedback = checked.error?.message ?? 'The runtime has not verified every mandatory task requirement.';
        exchanges.push({
          kind: 'conversation',
          messages: [{
            role: 'user',
            content: `Completion cannot be accepted yet:\n${feedback}\n\nCurrent requirement state:\n${input.getRequirementSummary()}\nContinue the task with a useful tool action, or report a blocker through helm.blocked only when a relevant tool failure is recorded.`,
          }],
        });
      }
      await emitDiagnostics();
    }

    await emitDiagnostics();
    throw new ActingAgentExecutionError(
      'MODEL_TURN_BUDGET_EXCEEDED',
      `The acting model reached its ${maxModelTurns}-turn inference budget before all compiled requirements were verified.`,
      { ...diagnostics, lastUnsatisfiedRequirements: [...diagnostics.lastUnsatisfiedRequirements] },
    );
  }
}
