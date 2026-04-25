import { config } from '../config.ts';
import { queryMemories, upsertMemory } from './memory.ts';

interface ToolTraceEntry {
  toolName: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
}

interface EpisodeInput {
  assistantText: string;
  conversationId: string;
  runId: string;
  userInput: string;
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: Record<string, unknown> }>;
}

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

const truncate = (value: string, max = 420): string =>
  value.length <= max ? value : `${value.slice(0, max)}...`;

const compactJson = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const toCompactToolOutput = (
  toolName: string,
  output: Record<string, unknown>,
): Record<string, unknown> => {
  if (toolName !== 'capture_screenshot') {
    return output;
  }

  const imageBase64 = normalizeText(output.imageBase64);
  return {
    bytes: output.bytes,
    cursor: output.cursor,
    geometry: output.geometry,
    imageSummary: imageBase64
      ? `[screenshot omitted ${Math.round(imageBase64.length / 1024)}KB]`
      : output.imageSummary,
    mimeType: output.mimeType,
    ok: output.ok,
  };
};

const buildToolTimeline = (input: EpisodeInput): ToolTraceEntry[] => {
  const maxLength = Math.max(input.toolCalls.length, input.toolResults.length);
  const entries: ToolTraceEntry[] = [];

  for (let index = 0; index < maxLength; index += 1) {
    const call = input.toolCalls[index];
    const result = input.toolResults[index];

    if (call) {
      entries.push({
        input: call.input,
        output: result
          ? toCompactToolOutput(result.toolName, result.output)
          : undefined,
        toolName: call.toolName,
      });
      continue;
    }

    if (result) {
      entries.push({
        output: toCompactToolOutput(result.toolName, result.output),
        toolName: result.toolName,
      });
    }
  }

  return entries;
};

const inferOutcome = (input: EpisodeInput): string => {
  const failedTool = input.toolResults.find((result) => {
    return result.output.ok === false || typeof result.output.error === 'string';
  });

  if (failedTool) {
    return `Blocked or degraded by ${failedTool.toolName}: ${truncate(
      normalizeText(failedTool.output.error) || compactJson(failedTool.output),
      260,
    )}`;
  }

  const finalText = normalizeText(input.assistantText);
  return finalText ? truncate(finalText, 360) : 'Run completed without final text.';
};

const buildEpisodeDocument = (input: EpisodeInput): string => {
  const toolTimeline = buildToolTimeline(input);
  const toolNames = [...new Set(toolTimeline.map((entry) => entry.toolName))];

  return [
    `Episode run: ${input.runId}`,
    `User goal: ${truncate(input.userInput, 500)}`,
    `Outcome: ${inferOutcome(input)}`,
    `Tool categories: ${toolNames.join(', ') || 'none'}`,
  ].join('\n');
};

export const upsertRunEpisode = async (
  input: EpisodeInput,
): Promise<void> => {
  const text = buildEpisodeDocument(input);

  await upsertMemory({
    collectionName: config.EPISODIC_MEMORY_COLLECTION,
    conversationId: input.conversationId,
    entityId: input.runId,
    entityType: 'episode',
    metadata: {
      preview: truncate(input.userInput, 240),
      toolCount: input.toolCalls.length + input.toolResults.length,
    },
    text,
  });
};

export const queryRunEpisodes = async (input: {
  conversationId: string;
  query: string;
  topK?: number;
}) => {
  return queryMemories({
    collectionName: config.EPISODIC_MEMORY_COLLECTION,
    conversationId: input.conversationId,
    query: input.query,
    topK: input.topK ?? config.MEMORY_TOP_K,
  });
};
