import { stepCountIs, streamText } from 'ai';
import { languageModel } from '../agent/model.ts';
import { buildAgentSystemPrompt } from '../agent/prompt.ts';
import {
  assertRunNotCancelled,
  buildRuntimeTools,
  isRunCancelledError,
  type ToolCapture,
  type ToolContext,
} from './tools/index.ts';
import { config } from '../config.ts';
import type { MessagePartType } from '../contracts.ts';
import {
  appendMessage,
  getLatestSummary,
  getMessagesByConversationId,
  getRunById,
  markRunCancelled,
  markRunCompleted,
  markRunFailed,
  markRunRunning,
} from '../database/store.ts';
import { getDesktopScreenSize } from '../desktop/desktop-service.ts';
import {
  queryRunEpisodes,
  upsertRunEpisode,
} from '../services/episodic-memory.ts';
import { queryMemories } from '../services/memory.ts';
import {
  acquireRunAbortSignal,
  releaseRunControl,
} from '../services/run-control.ts';
import { publishRunEvent } from '../services/run-events.ts';
import {
  buildSummaryContext,
  maybeSummarizeConversation,
} from '../services/summarizer.ts';

const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

type RunReasoningSetting = 'off' | 'low' | 'medium' | 'high' | 'on';

const normalizeText = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';


const messageToPlainText = (
  parts: Array<{ partType: MessagePartType; content: Record<string, unknown> }>,
): string => {
  return parts
    .map((part) => {
      if (part.partType === 'text') {
        return normalizeText(part.content.text);
      }
      if (part.partType === 'attachment') {
        const filename = normalizeText(part.content.filename) || 'attachment';
        const mediaType = normalizeText(part.content.mediaType);
        return mediaType
          ? `[attachment] ${filename} (${mediaType})`
          : `[attachment] ${filename}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

const buildTranscript = (
  messages: Array<{
    role: string;
    parts: Array<{
      partType: MessagePartType;
      content: Record<string, unknown>;
    }>;
  }>,
): string =>
  messages
    .map((message) => {
      const content = messageToPlainText(message.parts);
      return `${message.role.toUpperCase()}:\n${content || '(no textual content)'}`;
    })
    .join('\n\n');

const stringifyMemory = (memory: {
  distance: number | null;
  text: string;
}): string => {
  const prefix =
    typeof memory.distance === 'number'
      ? `distance=${memory.distance.toFixed(3)} `
      : '';
  return `${prefix}${memory.text}`.trim();
};

const truncate = (text: string, max = 240): string =>
  text.length <= max ? text : `${text.slice(0, max)}...`;

const collectAssistantParts = (args: {
  assistantText: string;
  reasoningText: string;
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: object }>;
}) => {
  const parts: Array<{
    type: MessagePartType;
    content: Record<string, unknown>;
  }> = [];

  if (args.reasoningText.trim()) {
    parts.push({
      content: { text: args.reasoningText.trim() },
      type: 'reasoning',
    });
  }

  for (const call of args.toolCalls) {
    parts.push({
      content: { input: call.input, toolName: call.toolName },
      type: 'tool_call',
    });
  }

  for (const result of args.toolResults) {
    parts.push({
      content: { output: result.output, toolName: result.toolName },
      type: 'tool_result',
    });
  }

  const text =
    args.assistantText.trim() ||
    (args.toolCalls.length > 0 || args.toolResults.length > 0
      ? 'Completed tool execution. Review the tool results above.'
      : 'No response generated.');

  parts.push({ content: { text }, type: 'text' });
  return parts;
};

export const runAgentConversation = async (args: {
  conversationId: string;
  runId: string;
  userInput: string;
  reasoning?: RunReasoningSetting;
  instructions?: string;
  userAttachments?: Array<{
    filename: string;
    mediaType: string;
    url: string;
  }>;
}): Promise<void> => {
  const { conversationId, runId, userInput } = args;
  const reasoning = args.reasoning;
  const instructions = args.instructions;
  const userAttachments = args.userAttachments ?? [];
  const abortSignal = acquireRunAbortSignal(runId);

  const toolCalls: Array<{ toolName: string; input: Record<string, unknown> }> =
    [];
  const toolResults: Array<{
    toolName: string;
    output: object;
  }> = [];
  let assistantText = '';
  let reasoningText = '';

  try {
    const existingRun = getRunById(runId);
    if (!existingRun || existingRun.status === 'cancelled') {
      return;
    }

    assertRunNotCancelled({ abortSignal, conversationId, runId });
    markRunRunning(runId);

    publishRunEvent({
      conversationId,
      eventType: 'run_started',
      payload: { runId, startedAt: new Date().toISOString() },
      runId,
    });

    const beforeMessages = getMessagesByConversationId(conversationId);

    const createdSummary = await maybeSummarizeConversation({
      conversationId,
      messages: beforeMessages,
    });

    if (createdSummary) {
      publishRunEvent({
        conversationId,
        eventType: 'context_summarizing',
        payload: { tokenEstimate: createdSummary.tokenEstimate },
        runId,
      });
      publishRunEvent({
        conversationId,
        eventType: 'summary_created',
        payload: {
          summaryId: createdSummary.id,
          tokenEstimate: createdSummary.tokenEstimate,
          upToMessageCount: createdSummary.upToMessageCount,
        },
        runId,
      });
    }

    const latestSummary = getLatestSummary(conversationId);
    const summaryContext = buildSummaryContext(latestSummary);

    // Query memories globally (across all conversations)
    const [retrievedMemories, retrievedEpisodes] = await Promise.all([
      queryMemories({ conversationId, query: userInput }),
      queryRunEpisodes({ conversationId, query: userInput }),
    ]);

    const memoryContext = [...retrievedEpisodes, ...retrievedMemories]
      .map(stringifyMemory)
      .filter(Boolean);

    // Only emit memory_reading when relevant memories were found
    if (memoryContext.length > 0) {
      publishRunEvent({
        conversationId,
        eventType: 'memory_reading',
        payload: { count: memoryContext.length, query: userInput.slice(0, 120) },
        runId,
      });
    }

    const system = buildAgentSystemPrompt({ memoryContext, summaryContext, customInstructions: instructions });

    let screenSize: { width: number; height: number } | null = null;
    try {
      screenSize = await getDesktopScreenSize();
    } catch (error) {
      throw new Error(
        `Desktop control is unavailable: ${toErrorMessage(error)}. Check docker availability or DESKTOP_CONTROL_MODE.`,
      );
    }

    const summaryCutoff = latestSummary?.upToMessageCount ?? 0;
    const contextMessages = getMessagesByConversationId(conversationId)
      .slice(summaryCutoff)
      .slice(-config.AGENT_CONTEXT_RECENT_MESSAGES);

    const transcript = buildTranscript(contextMessages);

    const promptBlocks = [
      'User objective:',
      userInput,
      '',
      ...(userAttachments.length > 0
        ? [
            'User-provided attachments:',
            ...userAttachments.map((a, i) => `${i + 1}. ${a.filename} (${a.mediaType})`),
            '',
          ]
        : []),
      screenSize
        ? `Desktop resolution: ${screenSize.width}x${screenSize.height}`
        : 'Desktop resolution: unavailable',
      '',
      'Recent conversation:',
      transcript || '(empty)',
    ];

    const toolContext: ToolContext = { abortSignal, conversationId, runId };

    const toolCapture: ToolCapture = {
      onToolCall: (entry) => toolCalls.push(entry),
      onToolResult: (entry) => toolResults.push(entry),
    };

    const runtimeTools = buildRuntimeTools({ capture: toolCapture, context: toolContext });

    const result = streamText({
      abortSignal,
      model: languageModel,
      prepareStep: ({ messages }) => {
        // Strip screenshot image data from all but the most recent screenshot tool result.
        // This prevents the model from confusing older screenshots with the current state
        // and avoids context bloat from accumulated PNG base64 data.
        let lastScreenshotIdx = -1;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i];
          if (msg.role !== 'tool') continue;
          const toolMsg = msg as { role: 'tool'; content: Array<{ type: string; toolName?: string; output?: unknown }> };
          const hasScreenshot = toolMsg.content.some(
            (part) => part.type === 'tool-result' && part.toolName === 'capture_screenshot',
          );
          if (hasScreenshot) {
            lastScreenshotIdx = i;
            break;
          }
        }

        if (lastScreenshotIdx <= 0) return {};

        const prunedMessages = messages.map((msg, idx) => {
          if (msg.role !== 'tool' || idx === lastScreenshotIdx) return msg;
          const toolMsg = msg as { role: 'tool'; content: Array<{ type: 'tool-result'; toolName?: string; output?: unknown }> };
          const prunedContent = toolMsg.content.map((part) => {
            if (
              part.type !== 'tool-result' ||
              part.toolName !== 'capture_screenshot' ||
              !part.output
            ) {
              return part;
            }
            // The raw execute() output is ScreenshotToolOutput — strip imageBase64
            // so toModelOutput produces a text-only summary for older screenshots.
            const output = part.output as Record<string, unknown>;
            if (!output.imageBase64) return part;
            return {
              ...part,
              output: { ...output, imageBase64: '' },
            };
          });
          return { ...toolMsg, content: prunedContent };
        });

        return { messages: prunedMessages as typeof messages };
      },
      prompt: promptBlocks.join('\n'),
      providerOptions: { reasoning: reasoning ?? 'on' } as any,
      stopWhen: [stepCountIs(config.AGENT_MAX_STEPS)],
      system,
      tools: runtimeTools,
    });

    for await (const chunk of result.fullStream) {
      assertRunNotCancelled({ abortSignal, conversationId, runId });

      if (chunk.type === 'text-delta') {
        const delta = chunk.text;
        if (delta) {
          assistantText += delta;
          publishRunEvent({
            conversationId,
            eventType: 'assistant_text',
            payload: { delta },
            runId,
          });
        }
        continue;
      }

      if (chunk.type === 'reasoning-delta') {
        const delta = chunk.text;
        if (delta) {
          reasoningText += delta;
          publishRunEvent({
            conversationId,
            eventType: 'reasoning',
            payload: { delta },
            runId,
          });
        }
        continue;
      }
    }

    const settledText = (await result.text).trim();
    if (!assistantText.trim() && settledText) {
      assistantText = settledText;
      publishRunEvent({
        conversationId,
        eventType: 'assistant_text',
        payload: { delta: settledText },
        runId,
      });
    }

    assertRunNotCancelled({ abortSignal, conversationId, runId });

    const assistantMessage = appendMessage({
      conversationId,
      parts: collectAssistantParts({ assistantText, reasoningText, toolCalls, toolResults }),
      role: 'assistant',
      runId,
    });

    markRunCompleted({
      assistantMessageId: assistantMessage.id,
      conversationId,
      runId,
    });

    publishRunEvent({
      conversationId,
      eventType: 'run_completed',
      payload: {
        assistantMessageId: assistantMessage.id,
        preview: truncate(assistantText.trim()),
      },
      runId,
    });

    publishRunEvent({
      conversationId,
      eventType: 'memory_saved',
      payload: { toolCallCount: toolCalls.length },
      runId,
    });

    // Persist episodic context for future runs (agent-decided facts are saved via save_memory tool)
    await upsertRunEpisode({
      assistantText,
      conversationId,
      runId,
      toolCalls,
      toolResults,
      userInput,
    });

    const afterMessages = getMessagesByConversationId(conversationId);
    const followUpSummary = await maybeSummarizeConversation({
      conversationId,
      messages: afterMessages,
    });

    if (followUpSummary) {
      publishRunEvent({
        conversationId,
        eventType: 'summary_created',
        payload: {
          summaryId: followUpSummary.id,
          tokenEstimate: followUpSummary.tokenEstimate,
          upToMessageCount: followUpSummary.upToMessageCount,
        },
        runId,
      });
    }
  } catch (error) {
    if (isRunCancelledError(error)) {
      const message = 'Run cancelled by user.';
      const changed = markRunCancelled({ conversationId, errorMessage: message, runId });

      if (changed) {
        publishRunEvent({ conversationId, eventType: 'run_cancelled', payload: { message }, runId });
        const partialParts: Parameters<typeof appendMessage>[0]['parts'] = [];
        if (reasoningText.trim()) {
          partialParts.push({ content: { text: reasoningText.trim() }, type: 'reasoning' });
        }
        for (const call of toolCalls) {
          partialParts.push({ content: { input: call.input, toolName: call.toolName }, type: 'tool_call' });
        }
        for (const result of toolResults) {
          partialParts.push({ content: { output: result.output, toolName: result.toolName }, type: 'tool_result' });
        }
        if (assistantText.trim()) {
          partialParts.push({ content: { text: assistantText.trim() }, type: 'text' });
        }
        partialParts.push({ content: { text: message }, type: 'status' });
        appendMessage({ conversationId, parts: partialParts, role: 'assistant', runId });
      }
      return;
    }

    const message = toErrorMessage(error);
    markRunFailed({ conversationId, errorMessage: message, runId });
    publishRunEvent({ conversationId, eventType: 'run_failed', payload: { message }, runId });
    appendMessage({
      conversationId,
      parts: [{ content: { text: `Run failed: ${message}` }, type: 'status' }],
      role: 'assistant',
      runId,
    });
  } finally {
    releaseRunControl(runId);
  }
};
