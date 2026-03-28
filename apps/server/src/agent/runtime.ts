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
import { queryMemories, upsertMemory } from '../services/memory.ts';
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

const MAX_CONTINUATION_PASSES = 10;

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

      if (part.partType === 'reasoning') {
        return normalizeText(part.content.text);
      }

      if (part.partType === 'tool_call') {
        const name = normalizeText(part.content.toolName);
        return name ? `[tool-call] ${name}` : '[tool-call]';
      }

      if (part.partType === 'tool_result') {
        const name = normalizeText(part.content.toolName);
        return name ? `[tool-result] ${name}` : '[tool-result]';
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

const toCompactToolOutput = (output: Record<string, unknown>) => {
  const compact: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(output)) {
    if (key === 'imageBase64') {
      const base64 = normalizeText(value);
      compact[key] = base64
        ? `[omitted base64 (${Math.round(base64.length / 1024)}KB)]`
        : '';
      continue;
    }

    if (typeof value === 'string' && value.length > 240) {
      compact[key] = `${value.slice(0, 240)}...`;
      continue;
    }

    compact[key] = value;
  }

  return compact;
};

const buildRecentToolActivitySummary = (args: {
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: Record<string, unknown> }>;
  limit?: number;
}): string => {
  const limit = args.limit ?? 6;
  const callLines = args.toolCalls.slice(-limit).map((call) => {
    return `tool_call ${call.toolName}: ${JSON.stringify(call.input)}`;
  });

  const resultLines = args.toolResults.slice(-limit).map((result) => {
    return `tool_result ${result.toolName}: ${JSON.stringify(
      toCompactToolOutput(result.output),
    )}`;
  });

  return [...callLines, ...resultLines].join('\n');
};

const isEmptyScreenshotOutput = (output: Record<string, unknown>): boolean => {
  const bytes = Number(output.bytes ?? 0);
  const imageBase64 = normalizeText(output.imageBase64);
  return !Number.isFinite(bytes) || bytes <= 0 || imageBase64.length === 0;
};

const buildFallbackAssistantText = (args: {
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: Record<string, unknown> }>;
}): string => {
  const hasEmptyScreenshot = args.toolResults.some((result) => {
    if (result.toolName !== 'capture_screenshot') {
      return false;
    }

    return isEmptyScreenshotOutput(result.output);
  });

  if (hasEmptyScreenshot) {
    return 'I could not capture a usable screenshot because the tool returned empty image data. The desktop session may not be ready or reachable.';
  }

  if (args.toolCalls.length > 0 || args.toolResults.length > 0) {
    return 'Completed tool execution, but the model returned no final text response. Review the tool results above.';
  }

  return 'No textual response generated.';
};

const collectAssistantParts = (args: {
  assistantText: string;
  reasoningText: string;
  toolCalls: Array<{ toolName: string; input: Record<string, unknown> }>;
  toolResults: Array<{ toolName: string; output: Record<string, unknown> }>;
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
      content: {
        input: call.input,
        toolName: call.toolName,
      },
      type: 'tool_call',
    });
  }

  for (const result of args.toolResults) {
    parts.push({
      content: {
        output: result.output,
        toolName: result.toolName,
      },
      type: 'tool_result',
    });
  }

  parts.push({
    content: {
      text:
        args.assistantText.trim() ||
        buildFallbackAssistantText({
          toolCalls: args.toolCalls,
          toolResults: args.toolResults,
        }),
    },
    type: 'text',
  });

  return parts;
};

export const runAgentConversation = async (args: {
  conversationId: string;
  runId: string;
  userInput: string;
  reasoning?: RunReasoningSetting;
  userAttachments?: Array<{
    filename: string;
    mediaType: string;
    url: string;
  }>;
}): Promise<void> => {
  const { conversationId, runId, userInput } = args;
  const reasoning = args.reasoning;
  const userAttachments = args.userAttachments ?? [];
  const abortSignal = acquireRunAbortSignal(runId);

  const toolCalls: Array<{ toolName: string; input: Record<string, unknown> }> =
    [];
  const toolResults: Array<{
    toolName: string;
    output: Record<string, unknown>;
  }> = [];

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
      payload: {
        runId,
        startedAt: new Date().toISOString(),
      },
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

    const retrievedMemories = await queryMemories({
      conversationId,
      query: userInput,
    });

    const memoryContext = retrievedMemories.map(stringifyMemory);
    const system = buildAgentSystemPrompt({
      memoryContext,
      summaryContext,
    });

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
            ...userAttachments.map((attachment, index) => {
              return `${index + 1}. ${attachment.filename} (${attachment.mediaType})`;
            }),
            '',
          ]
        : []),
      screenSize
        ? `Desktop geometry: ${screenSize.width}x${screenSize.height}`
        : 'Desktop geometry: unavailable',
      '',
      'Conversation transcript (recent context):',
      transcript || '(empty)',
      '',
      'Instructions:',
      '- Always begin with capture_screenshot unless you have a very recent screenshot result.',
      '- If geometry is missing or uncertain, call get_display_geometry before coordinate-based actions.',
      '- Treat screenshot/tool output as the only ground truth; do not infer unobserved details.',
      '- Use tools to interact with the desktop, one atomic step at a time.',
      '- Before each action, decide the expected visible outcome; after the action, verify that outcome.',
      '- Continue taking atomic steps in this same run until the objective is complete or blocked.',
      '- Do not stop after a single tool call if additional actions are required.',
      '- The objective is already provided above. Do not ask the user to restate or clarify the objective unless the objective text itself is empty.',
      '- Use click_mouse or double_click_mouse with x and y when targeting a specific UI element.',
      '- For opening desktop app icons, prefer double_click_mouse, then wait briefly, then capture_screenshot to confirm launch.',
      '- Treat coordinate inputs as display pixels (top-left origin); do not invent alternate coordinate scales unless values are explicitly normalized to [0,1].',
      '- For icon clicks, move_mouse first, capture_screenshot, verify cursor overlaps the icon glyph, then click/double-click.',
      '- If verification shows cursor off-target, adjust coordinates and retry; do not click blindly.',
      '- If a step does not work, do not repeat the same failed action more than twice; try an alternative route.',
      '- If the screen is ambiguous or unreadable, call capture_screenshot with detail: "high" before acting.',
      '- Verify major state changes with capture_screenshot.',
      '- Never claim success unless the expected change is visible in screenshot or explicitly confirmed by tool output.',
      '- Before finishing, provide a concise plain-language status update for the user and include one evidence sentence.',
      '- Finish only when the user goal is complete or clearly blocked.',
    ];

    const toolContext: ToolContext = {
      abortSignal,
      conversationId,
      runId,
    };

    const toolCapture: ToolCapture = {
      onToolCall: (entry) => {
        toolCalls.push(entry);
      },
      onToolResult: (entry) => {
        toolResults.push(entry);
      },
    };

    const runtimeTools = buildRuntimeTools({
      capture: toolCapture,
      context: toolContext,
    });

    let assistantText = '';
    let reasoningText = '';

    const runModelPass = async (prompt: string) => {
      const result = streamText({
        abortSignal,
        model: languageModel,
        prompt,
        providerOptions: {
          reasoning: reasoning ?? 'on',
        } as any,
        stopWhen: stepCountIs(config.AGENT_MAX_STEPS),
        system,
        tools: runtimeTools,
      });

      for await (const chunk of result.fullStream as AsyncIterable<
        Record<string, unknown>
      >) {
        assertRunNotCancelled({ abortSignal, conversationId, runId });
        const chunkType = normalizeText(chunk.type);

        if (chunkType === 'text-delta') {
          const delta = normalizeText(chunk.textDelta);
          if (delta) {
            assistantText += delta;
            publishRunEvent({
              conversationId,
              eventType: 'assistant_text',
              payload: {
                delta,
              },
              runId,
            });
          }
          continue;
        }

        if (chunkType.includes('reasoning')) {
          const delta =
            normalizeText(chunk.textDelta) ||
            normalizeText(chunk.reasoningDelta) ||
            normalizeText(chunk.text);

          if (delta) {
            reasoningText += `${delta}\n`;
            publishRunEvent({
              conversationId,
              eventType: 'reasoning',
              payload: {
                delta,
              },
              runId,
            });
          }

          continue;
        }
      }

      const settledText = (await result.text).trim();
      assertRunNotCancelled({ abortSignal, conversationId, runId });

      if (!assistantText.trim() && settledText) {
        assistantText = settledText;
        publishRunEvent({
          conversationId,
          eventType: 'assistant_text',
          payload: {
            delta: settledText,
          },
          runId,
        });
      }
    };

    const initialPrompt = promptBlocks.join('\n');
    await runModelPass(initialPrompt);

    let continuationPass = 0;
    while (
      !assistantText.trim() &&
      continuationPass < MAX_CONTINUATION_PASSES &&
      (toolCalls.length > 0 || toolResults.length > 0)
    ) {
      const toolActivityBefore = toolCalls.length + toolResults.length;
      continuationPass += 1;

      const continuationPrompt = [
        'Known user objective (do not ask the user to repeat this):',
        userInput,
        '',
        `Continuation pass ${continuationPass} of ${MAX_CONTINUATION_PASSES}.`,
        'Continue this same desktop automation objective. The prior model pass emitted tool activity but no final user-facing text.',
        'Do not ask for task clarification here unless the objective text above is empty.',
        'If you know the hotkey to open the application (if you are asked to open an application) instead of clicking the icon use the hotkey,in order to avoid issues with the mouse tool.',
        'Do not stop now. Either call the next required tool or provide a concise final status only if the objective is complete.',
        'If you call tools in this pass, you must also emit at least one short user-facing sentence before ending the pass.',
        'Do not repeat capture_screenshot immediately unless visual state likely changed.',
        'Do not hallucinate success: if uncertain, gather new evidence (wait, screenshot, or geometry check) before claiming outcome.',
        'If repeated coordinate clicks failed, change strategy instead of looping the same action. For example, if you are trying to do something on a window, the window might not be focused yet which causes the input to not work.',
        '',
        'Recent tool activity:',
        buildRecentToolActivitySummary({
          toolCalls,
          toolResults,
          limit: 8,
        }) || '(none)',
        '',
        'Return at least one short sentence before ending this pass.',
      ].join('\n');

      await runModelPass(continuationPrompt);

      if (assistantText.trim()) {
        break;
      }

      const toolActivityAfter = toolCalls.length + toolResults.length;
      if (toolActivityAfter <= toolActivityBefore) {
        break;
      }
    }

    if (!assistantText.trim()) {
      const fallbackText = buildFallbackAssistantText({
        toolCalls,
        toolResults,
      });

      assistantText = fallbackText;

      publishRunEvent({
        conversationId,
        eventType: 'assistant_text',
        payload: {
          delta: fallbackText,
        },
        runId,
      });
    }

    assertRunNotCancelled({ abortSignal, conversationId, runId });

    const assistantMessage = appendMessage({
      conversationId,
      parts: collectAssistantParts({
        assistantText,
        reasoningText,
        toolCalls,
        toolResults,
      }),
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

    const assistantMemoryText = [reasoningText.trim(), assistantText.trim()]
      .filter(Boolean)
      .join('\n\n');

    const userMemoryText = [
      userInput,
      ...userAttachments.map((attachment) => {
        return `Attachment: ${attachment.filename} (${attachment.mediaType})`;
      }),
    ]
      .filter(Boolean)
      .join('\n');

    await Promise.all([
      upsertMemory({
        conversationId,
        entityId: runId,
        entityType: 'run_user_input',
        metadata: {
          attachmentCount: userAttachments.length,
          preview: truncate(userInput),
        },
        text: userMemoryText,
      }),
      upsertMemory({
        conversationId,
        entityId: assistantMessage.id,
        entityType: 'run_assistant_output',
        metadata: { preview: truncate(assistantText) },
        text: assistantMemoryText,
      }),
    ]);

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
      const changed = markRunCancelled({
        conversationId,
        errorMessage: message,
        runId,
      });

      if (changed) {
        publishRunEvent({
          conversationId,
          eventType: 'run_cancelled',
          payload: {
            message,
          },
          runId,
        });

        appendMessage({
          conversationId,
          parts: [
            {
              content: {
                text: message,
              },
              type: 'status',
            },
          ],
          role: 'assistant',
          runId,
        });
      }

      return;
    }

    const message = toErrorMessage(error);

    markRunFailed({
      conversationId,
      errorMessage: message,
      runId,
    });

    publishRunEvent({
      conversationId,
      eventType: 'run_failed',
      payload: {
        message,
      },
      runId,
    });

    appendMessage({
      conversationId,
      parts: [
        {
          content: {
            text: `Run failed: ${message}`,
          },
          type: 'status',
        },
      ],
      role: 'assistant',
      runId,
    });
  } finally {
    releaseRunControl(runId);
  }
};
