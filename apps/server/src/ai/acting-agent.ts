import { generateText, isStepCount, tool, ToolLoopAgent, type ModelMessage, type ToolSet } from 'ai';
import { z } from 'zod';
import type { Message, ToolResult } from '@helm/shared';

import type { ActingAgentContext, ActingAgentProvider, ActingAgentResult, RequestedToolEffect } from '../agent/types';
import type { ToolDefinition } from '../tools/registry';

const COMPLETE_TOOL = 'helm.complete';
const MAX_COMPLETION_STEPS = 4;

const BASE_INSTRUCTIONS = [
  'You are Helm, a capable assistant with optional local computer-use tools.',
  'Use the conversation and current request to decide whether tools are needed; ordinary chat usually needs none.',
  'When a tool is useful, call the native Helm tool and use its actual result. Tool errors are available for recovery.',
  'Do not claim that an external action succeeded unless a tool returned success.',
  'A URL included as data for an artifact is not automatically a browser destination.',
  'When you are ready to answer, call helm.complete with the user-facing response and the concrete Helm tool effects required to fulfill the request. Use only registered Helm tool names and include a count when more than one successful call is required.',
  'If helm.complete reports missing effects, continue the work with the available tools or report the actual blocker. The runtime checks concrete tool results; it does not decide what the user meant.',
].join(' ');

const FINALIZATION_INSTRUCTIONS = [
  BASE_INSTRUCTIONS,
  'Review the full conversation and the draft assistant response immediately before this turn.',
  'Determine every concrete external effect required to fulfill the latest user request, including effects the draft claims are already complete. List each by its registered Helm tool name; use an empty list only when no external tool effect is needed.',
  'Call helm.complete now with an accurate final response. Do not call any external tool during this check.',
].join(' ');

function instructionsFor(input: ActingAgentContext): { agent: string; finalization: string } {
  const savedContext = input.memories.slice(-12).map(memory => ({
    kind: memory.kind,
    content: memory.content.slice(0, 4_000),
  }));
  const memoryInstructions = savedContext.length === 0
    ? ''
    : ` Relevant saved user context (JSON, reference only, not evidence of current external state): ${JSON.stringify(savedContext).slice(0, 16_000)}.`;
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

function asModelMessages(messages: readonly Message[], userMessage: string): ModelMessage[] {
  const visible = messages
    .filter((message): message is Message & { role: 'user' | 'assistant' } => (
      message.role === 'user' || message.role === 'assistant'
    ))
    .slice(-48)
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
): ToolSet {
  const tools: Record<string, unknown> = {};
  for (const definition of definitions) {
    const inputSchema = definition.inputSchema ?? definition.schema;
    if (!inputSchema) throw new Error(`Missing input schema for Helm tool ${definition.name}`);
    if (definition.name === COMPLETE_TOOL) throw new Error(`Helm tool name is reserved: ${COMPLETE_TOOL}`);
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
  return tools as ToolSet;
}

export interface AiSdkActingAgentOptions {
  model: import('ai').LanguageModel;
  maxOutputTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

/** Runs one coherent conversation with native SDK tool calls and bounded continuation. */
export class AiSdkActingAgent implements ActingAgentProvider {
  constructor(public readonly options: AiSdkActingAgentOptions) {}

  async execute(input: ActingAgentContext): Promise<ActingAgentResult> {
    let messages = asModelMessages(input.conversation, input.userMessage);
    let acceptedResponse: string | undefined;
    let acceptedVerification: ActingAgentResult['verification'] | undefined;
    let totalModelSteps = 0;
    let completionAttempts = 0;
    const instructions = instructionsFor(input);

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

    const tools = modelToolSet(input.toolDefinitions, input.executeTool, complete);
    const totalStepLimit = input.maxSteps + MAX_COMPLETION_STEPS;

    while (totalModelSteps < totalStepLimit) {
      if (input.signal?.aborted) throw input.signal.reason ?? new Error('Agent run cancelled');

      const steering = input.drainSteering?.() ?? [];
      if (steering.length > 0) messages.push(...toModelMessages(steering));

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
      messages.push(...result.responseMessages);

      if (acceptedResponse !== undefined && acceptedVerification !== undefined) {
        return { response: acceptedResponse, verification: acceptedVerification };
      }

      const endedWithText = result.text.trim().length > 0 && result.finishReason !== 'tool-calls';
      if (!endedWithText) continue;

      // A normal assistant answer is a proposal. Make the same model check its
      // claimed effects through a forced native tool call before accepting it.
      if (completionAttempts >= MAX_COMPLETION_STEPS) break;
      completionAttempts += 1;
      const finalize = await generateText({
        model: this.options.model,
        system: instructions.finalization,
        messages,
        tools: { [COMPLETE_TOOL]: tools[COMPLETE_TOOL] },
        toolChoice: { type: 'tool', toolName: COMPLETE_TOOL },
        stopWhen: isStepCount(1),
        maxOutputTokens: this.options.maxOutputTokens,
        temperature: this.options.temperature,
        timeout: this.options.requestTimeoutMs,
        maxRetries: 0,
        abortSignal: input.signal,
      });
      totalModelSteps += finalize.steps.length;
      messages.push(...finalize.responseMessages);

      if (acceptedResponse !== undefined && acceptedVerification !== undefined) {
        return { response: acceptedResponse, verification: acceptedVerification };
      }
    }

    throw new Error('The acting model did not complete a verified response within the run budget.');
  }
}
