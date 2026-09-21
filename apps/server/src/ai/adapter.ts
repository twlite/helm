import { tool, type LanguageModel, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentDecision, AgentTurnContext } from '@helm/shared';

/** The model adapter is intentionally inert until a real provider is configured. */
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
  tools: ToolSet;
}

/**
 * Placeholder for the eventual ToolLoopAgent integration. It is never created
 * by the default server because Helm must boot without an API key or model.
 */
export class AiSdkDecisionProvider implements DecisionProviderBoundary {
  constructor(public readonly options: AiSdkDecisionProviderOptions) {}

  async next(_context: AgentTurnContext): Promise<AgentDecision> {
    throw new Error('AI SDK provider is an integration boundary; no model is configured');
  }
}
