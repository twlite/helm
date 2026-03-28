import { memo, useCallback, useMemo, useState } from 'react';
import type { FileUIPart } from 'ai';
import type {
  ConversationMessageRecord,
  ConversationTimelineResponse,
  RunReasoningSetting,
  RunStatus,
} from '@/lib/api';
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from '@/components/ai-elements/attachments';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionAddScreenshot,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputHoverCard,
  PromptInputHoverCardContent,
  PromptInputHoverCardTrigger,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from '@/components/ai-elements/prompt-input';
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from '@/components/ai-elements/reasoning';
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from '@/components/ai-elements/tool';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { ArrowLeftIcon, BrainIcon } from 'lucide-react';
import { ScreenshotPreview } from './screenshot-preview';
import type { LiveToolCall, LiveToolResult, StreamState } from './types';
import { asRecord, formatStatus, getText, partText } from './utils';

const MESSAGE_VIRTUAL_WINDOW = 140;
const CONTEXT_ICON_RADIUS = 11;
const CONTEXT_ICON_SIZE = 28;
const CONTEXT_ICON_STROKE = 2.5;

interface AgentChatPanelProps {
  loading: boolean;
  timeline: ConversationTimelineResponse | null;
  messages: ConversationMessageRecord[];
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  streamState: StreamState;
  isBusy: boolean;
  isCancelling: boolean;
  liveRunStatus: RunStatus | null;
  liveRunId: string | null;
  liveAssistantText: string;
  liveReasoningMessages: string[];
  liveToolCalls: LiveToolCall[];
  liveToolResults: LiveToolResult[];
  activeConversationId: string | null;
  streamError: string | null;
  error: string | null;
  onStartRun: (args: {
    text: string;
    files?: FileUIPart[];
    reasoning?: RunReasoningSetting;
  }) => Promise<void>;
  onCancelRun: () => Promise<void>;
  onLoadOlderMessages: () => Promise<void>;
  onBackToChats?: () => void;
}

interface ScreenshotData {
  base64: string;
  cursor: {
    x: number;
    y: number;
  } | null;
  geometry: {
    height: number;
    width: number;
  } | null;
  mediaType: string;
}

const toScreenshotData = (
  output: Record<string, unknown>,
): ScreenshotData | null => {
  const base64 = getText(output.imageBase64);
  if (!base64) {
    return null;
  }

  const cursorRecord = asRecord(output.cursor);
  const cursorX = Number(cursorRecord.x);
  const cursorY = Number(cursorRecord.y);
  const cursor =
    Number.isFinite(cursorX) && Number.isFinite(cursorY)
      ? {
          x: cursorX,
          y: cursorY,
        }
      : null;

  const geometryRecord = asRecord(output.geometry);
  const geometryWidth = Number(geometryRecord.width);
  const geometryHeight = Number(geometryRecord.height);
  const geometry =
    Number.isFinite(geometryWidth) && Number.isFinite(geometryHeight)
      ? {
          height: geometryHeight,
          width: geometryWidth,
        }
      : null;

  return {
    base64,
    cursor,
    geometry,
    mediaType: getText(output.mimeType) || 'image/png',
  };
};

const toDisplayOutput = (
  output: Record<string, unknown>,
): Record<string, unknown> => {
  const screenshot = toScreenshotData(output);
  if (!screenshot) {
    return output;
  }

  const kb = Math.round(screenshot.base64.length / 1024);
  return {
    ...output,
    imageBase64: `[omitted screenshot base64 (${kb}KB)]`,
  };
};

const toAttachmentPartData = (
  content: Record<string, unknown>,
  id: string,
): (FileUIPart & { id: string }) | null => {
  const url = getText(content.url);
  if (!url) {
    return null;
  }

  return {
    filename: getText(content.filename) || 'attachment',
    id,
    mediaType: getText(content.mediaType) || 'application/octet-stream',
    type: 'file',
    url,
  };
};

const ComposerAttachments = () => {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments className="w-full" variant="list">
      {attachments.files.map((file) => (
        <Attachment
          data={file}
          key={file.id}
          onRemove={() => {
            attachments.remove(file.id);
          }}
        >
          <AttachmentPreview />
          <AttachmentInfo showMediaType={true} />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

const SummaryContextIcon = ({
  hasSummary,
  percent,
}: {
  hasSummary: boolean;
  percent: number;
}) => {
  const boundedPercent = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * CONTEXT_ICON_RADIUS;
  const dashOffset = circumference * (1 - boundedPercent / 100);

  return (
    <svg
      aria-label="Context summary coverage"
      className={cn(
        'size-7',
        hasSummary ? 'text-primary' : 'text-muted-foreground',
      )}
      role="img"
      viewBox={`0 0 ${CONTEXT_ICON_SIZE} ${CONTEXT_ICON_SIZE}`}
    >
      <circle
        cx={CONTEXT_ICON_SIZE / 2}
        cy={CONTEXT_ICON_SIZE / 2}
        fill="none"
        opacity="0.28"
        r={CONTEXT_ICON_RADIUS}
        stroke="currentColor"
        strokeWidth={CONTEXT_ICON_STROKE}
      />
      <circle
        cx={CONTEXT_ICON_SIZE / 2}
        cy={CONTEXT_ICON_SIZE / 2}
        fill="none"
        opacity="0.95"
        r={CONTEXT_ICON_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset}
        strokeLinecap="round"
        strokeWidth={CONTEXT_ICON_STROKE}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
      />
    </svg>
  );
};

const renderToolFromMessagePart = (
  part: { content: Record<string, unknown>; partType: string },
  index: number,
) => {
  const toolName = getText(part.content.toolName) || 'tool';
  const input = asRecord(part.content.input);
  const output = asRecord(part.content.output);
  const screenshot = toScreenshotData(output);

  if (part.partType === 'tool_call') {
    return (
      <Tool defaultOpen={false} key={`${toolName}-call-${index}`}>
        <ToolHeader
          state="input-available"
          toolName={toolName}
          type="dynamic-tool"
        />
        <ToolContent>
          <ToolInput input={input} />
        </ToolContent>
      </Tool>
    );
  }

  return (
    <Tool defaultOpen={false} key={`${toolName}-result-${index}`}>
      <ToolHeader
        state="output-available"
        toolName={toolName}
        type="dynamic-tool"
      />
      <ToolContent>
        {Object.keys(input).length > 0 ? <ToolInput input={input} /> : null}
        {screenshot ? (
          <ScreenshotPreview
            base64={screenshot.base64}
            cursor={screenshot.cursor}
            geometry={screenshot.geometry}
            mediaType={screenshot.mediaType}
            toolName={toolName}
          />
        ) : null}
        <ToolOutput errorText={undefined} output={toDisplayOutput(output)} />
      </ToolContent>
    </Tool>
  );
};

const renderMessage = (
  message: ConversationMessageRecord,
  options: { showReasoning: boolean },
) => {
  const from = message.role === 'user' ? 'user' : 'assistant';

  return (
    <Message from={from}>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (part.partType === 'reasoning') {
            if (!options.showReasoning) {
              return null;
            }

            const content = partText(part);
            return (
              <Reasoning defaultOpen={false} key={`${part.id}-${index}`}>
                <ReasoningTrigger />
                <ReasoningContent>{content}</ReasoningContent>
              </Reasoning>
            );
          }

          if (
            part.partType === 'tool_call' ||
            part.partType === 'tool_result'
          ) {
            return renderToolFromMessagePart(part, index);
          }

          if (part.partType === 'attachment') {
            const attachment = toAttachmentPartData(part.content, part.id);
            if (!attachment) {
              return null;
            }

            return (
              <Attachments key={`${part.id}-${index}`} variant="list">
                <Attachment data={attachment}>
                  <AttachmentPreview />
                  <AttachmentInfo showMediaType={true} />
                </Attachment>
              </Attachments>
            );
          }

          if (part.partType === 'status') {
            return (
              <Badge key={`${part.id}-${index}`} variant="secondary">
                {partText(part)}
              </Badge>
            );
          }

          return (
            <MessageResponse key={`${part.id}-${index}`}>
              {partText(part)}
            </MessageResponse>
          );
        })}
      </MessageContent>
    </Message>
  );
};

interface HistoricalConversationContentProps {
  timeline: ConversationTimelineResponse | null;
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  hiddenLoadedCount: number;
  messagesCount: number;
  visibleMessages: ConversationMessageRecord[];
  showReasoning: boolean;
  onLoadOlderMessages: () => Promise<void>;
  onRenderOlderLoaded: () => void;
}

const HistoricalConversationContent = memo(
  function HistoricalConversationContent({
    timeline,
    hasMoreMessages,
    loadingOlderMessages,
    hiddenLoadedCount,
    messagesCount,
    visibleMessages,
    showReasoning,
    onLoadOlderMessages,
    onRenderOlderLoaded,
  }: HistoricalConversationContentProps) {
    return (
      <>
        {timeline?.latestSummary ? (
          <Card className="bg-muted/40 ring-border/60" size="sm">
            <CardHeader>
              <CardTitle className="text-sm">
                Compressed Context Summary
              </CardTitle>
              <CardDescription>
                Covers first {timeline.latestSummary.upToMessageCount} messages
              </CardDescription>
            </CardHeader>
            <CardContent>
              <MessageResponse>
                {timeline.latestSummary.summaryText}
              </MessageResponse>
            </CardContent>
          </Card>
        ) : null}

        {hasMoreMessages ? (
          <div className="flex justify-center">
            <Button
              disabled={loadingOlderMessages}
              onClick={() => {
                void onLoadOlderMessages();
              }}
              size="sm"
              variant="outline"
            >
              {loadingOlderMessages
                ? 'Loading older messages...'
                : 'Load older messages'}
            </Button>
          </div>
        ) : null}

        {hiddenLoadedCount > 0 ? (
          <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-xs">
            <span>
              Virtualized view: showing latest {visibleMessages.length} of{' '}
              {messagesCount} loaded messages
            </span>
            <Button onClick={onRenderOlderLoaded} size="sm" variant="ghost">
              Render older loaded
            </Button>
          </div>
        ) : null}

        {messagesCount ? (
          visibleMessages.map((message) => (
            <div
              className="[contain-intrinsic-size:220px] [content-visibility:auto]"
              key={message.id}
            >
              {renderMessage(message, { showReasoning })}
            </div>
          ))
        ) : (
          <ConversationEmptyState
            description="Send a goal and Helm will observe, reason, and act through tool calls."
            title="No agent messages yet"
          />
        )}
      </>
    );
  },
);

interface LiveConversationContentProps {
  liveRunId: string | null;
  liveAssistantText: string;
  liveReasoningMessages: string[];
  liveToolCalls: LiveToolCall[];
  liveToolResults: LiveToolResult[];
  showReasoning: boolean;
  streamState: StreamState;
}

const LiveConversationContent = memo(function LiveConversationContent({
  liveRunId,
  liveAssistantText,
  liveReasoningMessages,
  liveToolCalls,
  liveToolResults,
  showReasoning,
  streamState,
}: LiveConversationContentProps) {
  const liveReasoningText = liveReasoningMessages
    .map((message) => message.trim())
    .filter(Boolean)
    .join('\n');
  const pendingToolCalls = liveToolCalls.slice(liveToolResults.length);
  const visiblePendingToolCalls =
    streamState === 'streaming' ? pendingToolCalls.slice(-1) : pendingToolCalls;
  const hasToolActivity =
    visiblePendingToolCalls.length > 0 || liveToolResults.length > 0;

  if (
    !liveRunId ||
    (!liveAssistantText &&
      !liveReasoningText &&
      liveToolCalls.length === 0 &&
      liveToolResults.length === 0)
  ) {
    return null;
  }

  return (
    <Message from="assistant">
      <MessageContent>
        {showReasoning && liveReasoningText ? (
          <Reasoning
            defaultOpen={true}
            isStreaming={streamState === 'streaming'}
          >
            <ReasoningTrigger />
            <ReasoningContent>{liveReasoningText}</ReasoningContent>
          </Reasoning>
        ) : null}

        {hasToolActivity ? (
          <div className="space-y-2">
            <p className="font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
              Tool activity
            </p>

            {visiblePendingToolCalls.map((toolCall, index) => (
              <Tool
                defaultOpen={false}
                key={`live-call-${toolCall.toolName}-${index}`}
              >
                <ToolHeader
                  state="input-available"
                  toolName={toolCall.toolName}
                  type="dynamic-tool"
                />
                <ToolContent>
                  <ToolInput input={toolCall.input} />
                </ToolContent>
              </Tool>
            ))}

            {liveToolResults.map((toolResult, index) => {
              const screenshot = toScreenshotData(toolResult.output);

              return (
                <Tool
                  defaultOpen={false}
                  key={`live-result-${toolResult.toolName}-${index}`}
                >
                  <ToolHeader
                    state="output-available"
                    toolName={toolResult.toolName}
                    type="dynamic-tool"
                  />
                  <ToolContent>
                    {screenshot ? (
                      <ScreenshotPreview
                        base64={screenshot.base64}
                        cursor={screenshot.cursor}
                        geometry={screenshot.geometry}
                        mediaType={screenshot.mediaType}
                        toolName={toolResult.toolName}
                      />
                    ) : null}
                    <ToolOutput
                      errorText={undefined}
                      output={toDisplayOutput(toolResult.output)}
                    />
                  </ToolContent>
                </Tool>
              );
            })}
          </div>
        ) : null}

        {liveAssistantText.trim() ? (
          <MessageResponse>{liveAssistantText}</MessageResponse>
        ) : null}
      </MessageContent>
    </Message>
  );
});

export function AgentChatPanel({
  loading,
  timeline,
  messages,
  hasMoreMessages,
  loadingOlderMessages,
  streamState,
  isBusy,
  isCancelling,
  liveRunStatus,
  liveRunId,
  liveAssistantText,
  liveReasoningMessages,
  liveToolCalls,
  liveToolResults,
  activeConversationId,
  streamError,
  error,
  onStartRun,
  onCancelRun,
  onLoadOlderMessages,
  onBackToChats,
}: AgentChatPanelProps) {
  const [renderWindow, setRenderWindow] = useState(MESSAGE_VIRTUAL_WINDOW);
  const [showReasoning, setShowReasoning] = useState(true);

  const latestSummary = timeline?.latestSummary;
  const hasSummary = Boolean(latestSummary);
  const summarizedMessageCount = latestSummary?.upToMessageCount ?? 0;
  const contextCoveragePercent = messages.length
    ? Math.min(
        100,
        Math.round((summarizedMessageCount / messages.length) * 100),
      )
    : 0;
  const summaryTokenEstimate = latestSummary?.tokenEstimate;
  const composerDisabled = !activeConversationId || isCancelling;

  const visibleMessages = useMemo(() => {
    if (messages.length <= renderWindow) {
      return messages;
    }

    return messages.slice(messages.length - renderWindow);
  }, [messages, renderWindow]);

  const hiddenLoadedCount = Math.max(
    0,
    messages.length - visibleMessages.length,
  );

  const handleRenderOlderLoaded = useCallback(() => {
    setRenderWindow((prev) => prev + MESSAGE_VIRTUAL_WINDOW);
  }, []);

  return (
    <Card
      className="flex h-full min-h-0 flex-col overflow-hidden border-border/70 bg-card/80"
      size="sm"
    >
      <CardHeader className="border-b border-border/70 pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <div className="flex items-center gap-2">
            {onBackToChats ? (
              <Button
                onClick={onBackToChats}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <ArrowLeftIcon className="size-4" />
              </Button>
            ) : null}
            <span>Agent Chat</span>
          </div>
          <div className="flex items-center gap-2">
            {isBusy ? <Spinner className="size-4" /> : null}
            <Badge variant={isBusy ? 'default' : 'outline'}>
              {isBusy ? 'Streaming' : 'Idle'}
            </Badge>
            {liveRunStatus ? (
              <Badge variant="secondary">{formatStatus(liveRunStatus)}</Badge>
            ) : null}
          </div>
        </CardTitle>
        <CardDescription>
          Includes messages, chain-of-thought, tool calls, and tool results
        </CardDescription>
      </CardHeader>

      <CardContent className="flex min-h-0 flex-1 flex-col gap-3 p-0">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
            <Spinner /> Loading conversations...
          </div>
        ) : (
          <>
            <Conversation className="min-h-0 flex-1">
              <ConversationContent>
                <HistoricalConversationContent
                  hasMoreMessages={hasMoreMessages}
                  hiddenLoadedCount={hiddenLoadedCount}
                  loadingOlderMessages={loadingOlderMessages}
                  messagesCount={messages.length}
                  onLoadOlderMessages={onLoadOlderMessages}
                  onRenderOlderLoaded={handleRenderOlderLoaded}
                  showReasoning={showReasoning}
                  timeline={timeline}
                  visibleMessages={visibleMessages}
                />

                <LiveConversationContent
                  liveAssistantText={liveAssistantText}
                  liveReasoningMessages={liveReasoningMessages}
                  liveRunId={liveRunId}
                  liveToolCalls={liveToolCalls}
                  liveToolResults={liveToolResults}
                  showReasoning={showReasoning}
                  streamState={streamState}
                />
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>

            <div className="border-t border-border/70 p-3">
              <PromptInput
                onSubmit={({ files, text }) => {
                  return onStartRun({
                    files,
                    reasoning: showReasoning ? 'on' : 'off',
                    text,
                  });
                }}
              >
                <PromptInputBody>
                  <ComposerAttachments />
                  <PromptInputTextarea
                    className="max-h-40 min-h-12"
                    disabled={isBusy || isCancelling}
                    placeholder="Describe what to do on the desktop..."
                  />
                </PromptInputBody>
                <PromptInputFooter className="items-end gap-1.5">
                  <PromptInputTools className="gap-1.5">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger
                        disabled={composerDisabled || isBusy}
                        tooltip="Attach files"
                      />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                        <PromptInputActionAddScreenshot />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>

                    <PromptInputButton
                      aria-label={
                        showReasoning
                          ? 'Reasoning enabled'
                          : 'Reasoning disabled'
                      }
                      className={cn(
                        showReasoning
                          ? 'bg-amber-500/18 text-amber-700 ring-1 ring-amber-500/30 hover:bg-amber-500/26 dark:text-amber-300'
                          : undefined,
                      )}
                      onClick={() => {
                        setShowReasoning((prev) => !prev);
                      }}
                      tooltip={
                        showReasoning
                          ? 'Reasoning mode: on'
                          : 'Reasoning mode: off'
                      }
                    >
                      <BrainIcon className="size-4" />
                    </PromptInputButton>
                  </PromptInputTools>
                  <div className="flex items-center">
                    <PromptInputSubmit
                      aria-label={isBusy ? 'Cancel run' : 'Submit prompt'}
                      className={cn(
                        'shrink-0',
                        isBusy && !isCancelling
                          ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                          : undefined,
                      )}
                      disabled={composerDisabled}
                      onStop={() => {
                        void onCancelRun();
                      }}
                      status={
                        isCancelling
                          ? 'submitted'
                          : isBusy
                            ? 'streaming'
                            : 'ready'
                      }
                    />
                  </div>
                </PromptInputFooter>
              </PromptInput>

              <div className="mt-1.5 flex justify-end">
                <PromptInputHoverCard>
                  <PromptInputHoverCardTrigger>
                    <Button
                      aria-label="View context summary details"
                      className="size-4"
                      size="icon-xs"
                      type="button"
                      variant="ghost"
                    >
                      <SummaryContextIcon
                        hasSummary={hasSummary}
                        percent={contextCoveragePercent}
                      />
                    </Button>
                  </PromptInputHoverCardTrigger>
                  <PromptInputHoverCardContent align="end" className="w-72 p-3">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
                          Context Summary
                        </p>
                        <Badge variant={hasSummary ? 'secondary' : 'outline'}>
                          {contextCoveragePercent}%
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {hasSummary
                          ? 'Older messages are compressed into a summary so the active context stays compact.'
                          : 'No summary has been generated yet. Full message history remains in context.'}
                      </p>
                      <div className="grid grid-cols-2 gap-2 rounded-lg border border-border/60 bg-muted/35 p-2 text-xs">
                        <div>
                          <p className="text-muted-foreground">Loaded</p>
                          <p className="font-medium">{messages.length}</p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">Summarized</p>
                          <p className="font-medium">
                            {summarizedMessageCount}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">
                            Summary tokens
                          </p>
                          <p className="font-medium">
                            {summaryTokenEstimate ?? 'Not available'}
                          </p>
                        </div>
                        <div>
                          <p className="text-muted-foreground">State</p>
                          <p className="font-medium">
                            {isCancelling
                              ? 'Cancelling'
                              : isBusy
                                ? 'Streaming'
                                : 'Idle'}
                          </p>
                        </div>
                      </div>
                    </div>
                  </PromptInputHoverCardContent>
                </PromptInputHoverCard>
              </div>

              {streamError ? (
                <p className="mt-2 text-destructive text-xs">{streamError}</p>
              ) : null}
              {error ? (
                <p className="mt-2 text-destructive text-xs">{error}</p>
              ) : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
