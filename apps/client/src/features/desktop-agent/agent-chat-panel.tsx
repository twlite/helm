import { memo, useCallback, useMemo, useRef, useState } from 'react';
import type { FileUIPart } from 'ai';
import type {
  ContextSummaryStats,
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
import {
  ArrowRightIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  GripVerticalIcon,
  ListIcon,
  ListPlusIcon,
  SendIcon,
  XIcon,
} from 'lucide-react';
import { ScreenshotPreview } from './screenshot-preview';
import type {
  AgentStatus,
  LiveEvent,
  LiveStatusKind,
  QueuedMessage,
  StreamState,
} from './types';
import { asRecord, getText, partText } from './utils';

const MESSAGE_VIRTUAL_WINDOW = 140;
const CONTEXT_ICON_RADIUS = 8;
const CONTEXT_ICON_SIZE = 20;
const CONTEXT_ICON_STROKE = 2;
const SUMMARY_HISTORY_LIMIT = 4;

const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  idle: 'Idle',
  starting: 'Starting…',
  thinking: 'Thinking…',
  working: 'Working…',
  responding: 'Responding…',
  reading_memory: 'Reading memory…',
  compressing: 'Compressing context…',
  cancelling: 'Cancelling…',
};

interface AgentChatPanelProps {
  loading: boolean;
  timeline: ConversationTimelineResponse | null;
  messages: ConversationMessageRecord[];
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  streamState: StreamState;
  agentStatus: AgentStatus;
  isBusy: boolean;
  isCancelling: boolean;
  liveRunStatus: RunStatus | null;
  liveRunId: string | null;
  liveEvents: LiveEvent[];
  activeConversationId: string | null;
  streamError: string | null;
  error: string | null;
  messageQueue: QueuedMessage[];
  onStartRun: (args: {
    text: string;
    files?: FileUIPart[];
    reasoning?: RunReasoningSetting;
  }) => Promise<void>;
  onCancelRun: () => Promise<void>;
  onLoadOlderMessages: () => Promise<void>;
  onViewChats?: () => void;
  onEnqueueMessage: (text: string) => void;
  onDequeueMessage: (id: string) => void;
  onReorderQueue: (from: number, to: number) => void;
  onSteerWithMessage: (id: string) => Promise<void>;
}

interface ScreenshotData {
  base64: string;
  cursor: { x: number; y: number } | null;
  geometry: { height: number; width: number } | null;
  mediaType: string;
}

const toScreenshotData = (output: Record<string, unknown>): ScreenshotData | null => {
  const base64 = getText(output.imageBase64);
  if (!base64) return null;
  const cursorRecord = asRecord(output.cursor);
  const cursorX = Number(cursorRecord.x);
  const cursorY = Number(cursorRecord.y);
  const cursor =
    Number.isFinite(cursorX) && Number.isFinite(cursorY) ? { x: cursorX, y: cursorY } : null;
  const geometryRecord = asRecord(output.geometry);
  const gw = Number(geometryRecord.width);
  const gh = Number(geometryRecord.height);
  const geometry = Number.isFinite(gw) && Number.isFinite(gh) ? { height: gh, width: gw } : null;
  return { base64, cursor, geometry, mediaType: getText(output.mimeType) || 'image/png' };
};

const toDisplayOutput = (output: Record<string, unknown>): Record<string, unknown> => {
  const screenshot = toScreenshotData(output);
  if (!screenshot) return output;
  const kb = Math.round(screenshot.base64.length / 1024);
  return { ...output, imageBase64: `[omitted screenshot base64 (${kb}KB)]` };
};

const formatNumber = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString()
    : 'N/A';

const formatTokenCount = (value: number | null | undefined): string =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString()} tok`
    : 'N/A';

const formatDateTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
  }).format(date);
};

const splitReasoningSteps = (text: string): string[] => {
  const clean = text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n');
  if (!clean) return [];
  const para = clean
    .split(/\n{2,}|(?=\n(?:[-*]|\d+[.)])\s+)/g)
    .map((s) => s.trim())
    .filter(Boolean);
  if (para.length > 1) return para;
  return clean
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/g)
    .map((s) => s.trim())
    .filter(Boolean);
};

const getToolResultSummary = (toolName: string, output: Record<string, unknown>): string => {
  const error = getText(output.error);
  if (error) return error;
  if (toolName === 'capture_screenshot') {
    const geometry = asRecord(output.geometry);
    const w = Number(geometry.width);
    const h = Number(geometry.height);
    const imageSummary = getText(output.imageSummary);
    const size = Number.isFinite(w) && Number.isFinite(h) ? `${w}x${h}` : 'unknown size';
    return imageSummary || `Captured desktop screenshot (${size}).`;
  }
  if (toolName === 'move_mouse' || toolName === 'click_mouse') {
    const target = asRecord(output.resolvedTarget);
    const x = Number(target.x);
    const y = Number(target.y);
    if (Number.isFinite(x) && Number.isFinite(y)) return `Target resolved to (${x}, ${y}).`;
  }
  if (toolName === 'open_application') {
    const app = getText(output.app) || 'application';
    const action = getText(output.action);
    if (action === 'focused_existing') return `Focused existing ${app} window.`;
    if (action === 'launched') return `Launched ${app}.`;
    return `Requested ${app} launch.`;
  }
  if (toolName === 'navigate_browser_url') {
    const url = getText(output.url);
    return url ? `Navigated Firefox to ${url}.` : 'Navigated Firefox.';
  }
  if (toolName === 'run_terminal_command') {
    const cmd = getText(output.command);
    return cmd ? `Ran terminal command: ${cmd}` : 'Ran terminal command.';
  }
  if (toolName === 'list_desktop_windows') {
    const count = Number(output.count);
    return Number.isFinite(count)
      ? `Found ${count} visible window${count === 1 ? '' : 's'}.`
      : 'Listed visible windows.';
  }
  return output.ok === false ? 'Tool reported failure.' : 'Tool completed.';
};

const ReasoningStepList = ({ text }: { text: string }) => {
  const steps = splitReasoningSteps(text);
  if (steps.length === 0) return null;
  return (
    <div className="mt-3 space-y-2">
      {steps.map((step, index) => (
        <div
          className="rounded-lg border border-border/60 bg-muted/25 px-3 py-2 text-muted-foreground text-sm"
          key={`${index}-${step.slice(0, 24)}`}
        >
          <div className="mb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wide">
            Step {index + 1}
          </div>
          <MessageResponse>{step}</MessageResponse>
        </div>
      ))}
    </div>
  );
};

const ToolResultSummary = ({ output, toolName }: { output: Record<string, unknown>; toolName: string }) => {
  const isError = output.ok === false || Boolean(getText(output.error));
  return (
    <div
      className={cn(
        'rounded-lg border px-3 py-2 text-sm',
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : 'border-border/60 bg-muted/25 text-muted-foreground',
      )}
    >
      {getToolResultSummary(toolName, output)}
    </div>
  );
};

interface ToolActivityEntry {
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  toolName: string;
}

const buildToolEntriesFromParts = (
  parts: Array<{ content: Record<string, unknown>; partType: string }>,
): ToolActivityEntry[] => {
  const calls = parts
    .filter((p) => p.partType === 'tool_call')
    .map((p) => ({ input: asRecord(p.content.input), toolName: getText(p.content.toolName) || 'tool' }));
  const results = parts
    .filter((p) => p.partType === 'tool_result')
    .map((p) => ({ output: asRecord(p.content.output), toolName: getText(p.content.toolName) || 'tool' }));
  const count = Math.max(calls.length, results.length);
  return Array.from({ length: count }, (_, i) => ({
    input: calls[i]?.input ?? {},
    output: results[i]?.output ?? null,
    toolName: results[i]?.toolName ?? calls[i]?.toolName ?? 'tool',
  }));
};

const ToolActivityGroup = ({ entries, isStreaming = false }: { entries: ToolActivityEntry[]; isStreaming?: boolean }) => {
  if (entries.length === 0) return null;
  const latestCompleted = [...entries].reverse().find((e) => e.output);
  const latestScreenshot = latestCompleted?.output ? toScreenshotData(latestCompleted.output) : null;
  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.toolName] = (acc[e.toolName] ?? 0) + 1;
    return acc;
  }, {});
  const countsText = Object.entries(counts).map(([n, c]) => `${n} x${c}`).join(', ');

  return (
    <div className="rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium text-sm">Tool activity</p>
          <p className="text-muted-foreground text-xs">
            {entries.length} event{entries.length === 1 ? '' : 's'}
            {countsText ? `, ${countsText}` : ''}
          </p>
        </div>
        {isStreaming ? (
          <Badge className="gap-1" variant="secondary">
            <Spinner className="size-3" />
            Running
          </Badge>
        ) : null}
      </div>
      {latestCompleted?.output ? (
        <div className="mt-3 space-y-2">
          <ToolResultSummary output={latestCompleted.output} toolName={latestCompleted.toolName} />
          {latestScreenshot ? (
            <ScreenshotPreview
              base64={latestScreenshot.base64}
              cursor={latestScreenshot.cursor}
              geometry={latestScreenshot.geometry}
              mediaType={latestScreenshot.mediaType}
              toolName={latestCompleted.toolName}
            />
          ) : null}
        </div>
      ) : null}
      <details className="mt-3 text-xs">
        <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
          Show detailed tool log
        </summary>
        <div className="mt-2 space-y-2">
          {entries.map((entry, index) => (
            <Tool defaultOpen={false} key={`${entry.toolName}-${index}`}>
              <ToolHeader
                state={entry.output ? 'output-available' : 'input-available'}
                toolName={entry.toolName}
                type="dynamic-tool"
              />
              <ToolContent>
                {Object.keys(entry.input).length > 0 ? <ToolInput input={entry.input} /> : null}
                {entry.output ? (
                  <ToolOutput errorText={undefined} output={toDisplayOutput(entry.output)} />
                ) : null}
              </ToolContent>
            </Tool>
          ))}
        </div>
      </details>
    </div>
  );
};

const toAttachmentPartData = (
  content: Record<string, unknown>,
  id: string,
): (FileUIPart & { id: string }) | null => {
  const url = getText(content.url);
  if (!url) return null;
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
  if (attachments.files.length === 0) return null;
  return (
    <Attachments className="w-full" variant="list">
      {attachments.files.map((file) => (
        <Attachment data={file} key={file.id} onRemove={() => attachments.remove(file.id)}>
          <AttachmentPreview />
          <AttachmentInfo showMediaType={true} />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

const SummaryContextIcon = ({ hasSummary, percent }: { hasSummary: boolean; percent: number }) => {
  const bounded = Math.max(0, Math.min(100, percent));
  const circumference = 2 * Math.PI * CONTEXT_ICON_RADIUS;
  const dashOffset = circumference * (1 - bounded / 100);
  return (
    <svg
      aria-label="Context summary coverage"
      className={cn('size-5', hasSummary ? 'text-primary' : 'text-muted-foreground')}
      role="img"
      viewBox={`0 0 ${CONTEXT_ICON_SIZE} ${CONTEXT_ICON_SIZE}`}
    >
      <circle cx={CONTEXT_ICON_SIZE / 2} cy={CONTEXT_ICON_SIZE / 2} fill="none" opacity="0.28" r={CONTEXT_ICON_RADIUS} stroke="currentColor" strokeWidth={CONTEXT_ICON_STROKE} />
      <circle
        cx={CONTEXT_ICON_SIZE / 2} cy={CONTEXT_ICON_SIZE / 2} fill="none" opacity="0.95"
        r={CONTEXT_ICON_RADIUS} stroke="currentColor"
        strokeDasharray={`${circumference} ${circumference}`}
        strokeDashoffset={dashOffset} strokeLinecap="round"
        strokeWidth={CONTEXT_ICON_STROKE}
        style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
      />
    </svg>
  );
};

const ContextMetric = ({
  label,
  value,
}: {
  label: string;
  value: string;
}) => (
  <div className="min-w-0 rounded-md border border-border/55 bg-background/70 px-2.5 py-2">
    <p className="truncate text-[11px] text-muted-foreground">{label}</p>
    <p className="mt-0.5 truncate font-medium text-sm">{value}</p>
  </div>
);

const ContextProgress = ({
  label,
  percent,
  value,
}: {
  label: string;
  percent: number;
  value: string;
}) => {
  const bounded = Math.max(0, Math.min(100, percent));
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            'h-full rounded-full transition-[width]',
            bounded >= 80 ? 'bg-amber-500' : bounded >= 55 ? 'bg-blue-500' : 'bg-emerald-500',
          )}
          style={{ width: `${bounded}%` }}
        />
      </div>
    </div>
  );
};

const fallbackContextSummary = (args: {
  latestSummary: ConversationTimelineResponse['latestSummary'];
  messagesLength: number;
  totalMessageCount: number;
}): ContextSummaryStats => {
  const summarizedMessageCount = args.latestSummary?.upToMessageCount ?? 0;
  return {
    activeMessageCount: Math.max(0, args.totalMessageCount - summarizedMessageCount),
    activeTokenEstimate: 0,
    compressionPercent:
      args.totalMessageCount > 0
        ? Math.round((summarizedMessageCount / args.totalMessageCount) * 100)
        : 0,
    contextWindowTokens: null,
    latestSummaryTokenEstimate: null,
    source: 'fallback',
    summarizedMessageCount,
    summarizedTokenEstimate: args.latestSummary?.tokenEstimate ?? 0,
    summaryCount: args.latestSummary ? 1 : 0,
    summaryTokenEstimate: 0,
    totalMessageCount: args.totalMessageCount || args.messagesLength,
    triggerTokens: 0,
    usagePercent: 0,
  };
};

const ContextSummaryHoverCard = ({
  contextSummary,
  isBusy,
  isCancelling,
  isSummarizing,
  latestSummary,
  liveRunStatus,
  summaryHistory,
}: {
  contextSummary: ContextSummaryStats;
  isBusy: boolean;
  isCancelling: boolean;
  isSummarizing: boolean;
  latestSummary: ConversationTimelineResponse['latestSummary'];
  liveRunStatus: RunStatus | null;
  summaryHistory: ConversationTimelineResponse['summaryHistory'];
}) => {
  const hasSummary = contextSummary.summaryCount > 0;
  const stateLabel = isCancelling
    ? 'Cancelling'
    : isSummarizing
      ? 'Summarizing'
      : isBusy
        ? liveRunStatus === 'queued'
          ? 'Queued'
          : 'Streaming'
        : 'Idle';
  const recentHistory = summaryHistory.slice(-SUMMARY_HISTORY_LIMIT).reverse();

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium text-xs text-muted-foreground uppercase tracking-wide">
            Context Summary
          </p>
          <p className="mt-1 text-sm leading-snug">
            {hasSummary
              ? 'Older messages are compressed while recent turns stay available verbatim.'
              : 'No summary has been created yet. The active context is still raw message history.'}
          </p>
        </div>
        <Badge variant={isSummarizing ? 'default' : hasSummary ? 'secondary' : 'outline'}>
          {stateLabel}
        </Badge>
      </div>

      <div className="rounded-lg border border-border/60 bg-muted/25 p-3">
        <ContextProgress
          label="Active context used"
          percent={contextSummary.usagePercent}
          value={`${contextSummary.usagePercent}%`}
        />
        <div className="mt-3 grid grid-cols-2 gap-2">
          <ContextMetric
            label="Active tokens"
            value={formatTokenCount(contextSummary.activeTokenEstimate)}
          />
          <ContextMetric
            label="Trigger"
            value={formatTokenCount(contextSummary.triggerTokens)}
          />
          <ContextMetric
            label="Context window"
            value={
              contextSummary.contextWindowTokens
                ? formatTokenCount(contextSummary.contextWindowTokens)
                : 'Provider unknown'
            }
          />
          <ContextMetric
            label="Threshold source"
            value={contextSummary.source}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <ContextMetric
          label="Total messages"
          value={formatNumber(contextSummary.totalMessageCount)}
        />
        <ContextMetric
          label="Summarized"
          value={`${formatNumber(contextSummary.summarizedMessageCount)} (${contextSummary.compressionPercent}%)`}
        />
        <ContextMetric
          label="Compressed tokens"
          value={formatTokenCount(contextSummary.summarizedTokenEstimate)}
        />
        <ContextMetric
          label="Summary tokens"
          value={formatTokenCount(contextSummary.summaryTokenEstimate)}
        />
      </div>

      {latestSummary ? (
        <div className="rounded-lg border border-border/60 bg-background/75 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-xs">Latest summary</p>
            <span className="text-[11px] text-muted-foreground">
              {formatDateTime(latestSummary.createdAt)}
            </span>
          </div>
          <p className="mt-1 line-clamp-3 text-muted-foreground text-xs leading-relaxed">
            {latestSummary.summaryText}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge variant="outline">covers {latestSummary.upToMessageCount} messages</Badge>
            <Badge variant="outline">
              {formatTokenCount(contextSummary.latestSummaryTokenEstimate)}
            </Badge>
          </div>
        </div>
      ) : null}

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="font-medium text-xs">Summary history</p>
          <span className="text-[11px] text-muted-foreground">
            {contextSummary.summaryCount} total
          </span>
        </div>
        {recentHistory.length > 0 ? (
          <div className="space-y-1.5">
            {recentHistory.map((summary) => (
              <div
                className="grid grid-cols-[1fr_auto] gap-2 rounded-md border border-border/50 bg-muted/20 px-2.5 py-2 text-xs"
                key={summary.id}
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    {formatDateTime(summary.createdAt)}
                  </p>
                  <p className="truncate text-muted-foreground">
                    covers {summary.upToMessageCount} messages
                  </p>
                </div>
                <span className="self-center text-muted-foreground">
                  {formatTokenCount(summary.tokenEstimate)}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-md border border-dashed border-border/70 px-3 py-2 text-muted-foreground text-xs">
            No compression history yet.
          </div>
        )}
      </div>
    </div>
  );
};

const renderMessage = (message: ConversationMessageRecord, options: { showReasoning: boolean }) => {
  const from = message.role === 'user' ? 'user' : 'assistant';
  const toolParts = message.parts.filter(
    (p) => p.partType === 'tool_call' || p.partType === 'tool_result',
  );
  let renderedToolActivity = false;

  return (
    <Message from={from}>
      <MessageContent>
        {message.parts.map((part, index) => {
          if (part.partType === 'reasoning') {
            if (!options.showReasoning) return null;
            return (
              <Reasoning defaultOpen={false} key={`${part.id}-${index}`}>
                <ReasoningTrigger />
                <ReasoningStepList text={partText(part)} />
              </Reasoning>
            );
          }
          if (part.partType === 'tool_call' || part.partType === 'tool_result') {
            if (renderedToolActivity) return null;
            renderedToolActivity = true;
            return (
              <ToolActivityGroup
                entries={buildToolEntriesFromParts(toolParts)}
                key={`${message.id}-tool-activity`}
              />
            );
          }
          if (part.partType === 'attachment') {
            const attachment = toAttachmentPartData(part.content, part.id);
            if (!attachment) return null;
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
            return <Badge key={`${part.id}-${index}`} variant="secondary">{partText(part)}</Badge>;
          }
          return <MessageResponse key={`${part.id}-${index}`}>{partText(part)}</MessageResponse>;
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

const HistoricalConversationContent = memo(function HistoricalConversationContent({
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
            <CardTitle className="text-sm">Compressed Context Summary</CardTitle>
            <CardDescription>
              Covers first {timeline.latestSummary.upToMessageCount} messages
            </CardDescription>
          </CardHeader>
          <CardContent>
            <MessageResponse>{timeline.latestSummary.summaryText}</MessageResponse>
          </CardContent>
        </Card>
      ) : null}

      {hasMoreMessages ? (
        <div className="flex justify-center">
          <Button disabled={loadingOlderMessages} onClick={() => { void onLoadOlderMessages(); }} size="sm" variant="outline">
            {loadingOlderMessages ? 'Loading older messages...' : 'Load older messages'}
          </Button>
        </div>
      ) : null}

      {hiddenLoadedCount > 0 ? (
        <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/35 px-3 py-2 text-xs">
          <span>Virtualized view: showing latest {visibleMessages.length} of {messagesCount} loaded messages</span>
          <Button onClick={onRenderOlderLoaded} size="sm" variant="ghost">Render older loaded</Button>
        </div>
      ) : null}

      {messagesCount ? (
        visibleMessages.map((message) => (
          <div className="[contain-intrinsic-size:220px] [content-visibility:auto]" key={message.id}>
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
});

// ─── Status Chip with expandable detail ───────────────────────────────────────

const STATUS_META: Record<LiveStatusKind, { label: string; icon: string; className: string }> = {
  memory_reading: {
    label: 'Reading memory',
    icon: '🧠',
    className: 'border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400',
  },
  memory_saved: {
    label: 'Memory saved',
    icon: '💾',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
  context_summarizing: {
    label: 'Compressing context',
    icon: '📦',
    className: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
  },
  context_summarized: {
    label: 'Context compressed',
    icon: '✅',
    className: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  },
};

type StatusEvent = Extract<LiveEvent, { type: 'status' }>;

const StatusChipDetail = ({ event }: { event: StatusEvent }) => {
  if (event.kind === 'memory_reading') {
    const { count, query } = event.payload;
    return (
      <div className="space-y-1">
        {typeof count === 'number' ? (
          <p className="text-xs">
            <span className="font-semibold">{count}</span>{' '}
            relevant {count === 1 ? 'memory' : 'memories'} retrieved via RAG similarity search.
          </p>
        ) : null}
        {query ? <p className="text-xs italic opacity-75">Query: "{query}"</p> : null}
      </div>
    );
  }
  if (event.kind === 'memory_saved') {
    const { toolCallCount } = event.payload;
    return (
      <p className="text-xs">
        Episodic run memory and semantic embeddings persisted to ChromaDB
        {typeof toolCallCount === 'number' ? ` (${toolCallCount} tool call${toolCallCount === 1 ? '' : 's'} recorded)` : ''}.
      </p>
    );
  }
  if (event.kind === 'context_summarizing') {
    const {
      contextWindowTokens,
      source,
      tokenEstimate,
      triggerTokens,
      upToMessageCount,
    } = event.payload;
    return (
      <div className="space-y-2 text-xs">
        <p>
          Older messages are being compressed before the active context exceeds the model budget.
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className="opacity-70">Active estimate</p>
            <p className="font-semibold">{formatTokenCount(tokenEstimate)}</p>
          </div>
          <div>
            <p className="opacity-70">Trigger</p>
            <p className="font-semibold">{formatTokenCount(triggerTokens)}</p>
          </div>
          <div>
            <p className="opacity-70">Context window</p>
            <p className="font-semibold">{formatTokenCount(contextWindowTokens)}</p>
          </div>
          <div>
            <p className="opacity-70">Covers through</p>
            <p className="font-semibold">
              {typeof upToMessageCount === 'number' ? `${upToMessageCount} messages` : 'N/A'}
            </p>
          </div>
        </div>
        {source ? <p className="opacity-70">Threshold source: {source}</p> : null}
      </div>
    );
  }
  if (event.kind === 'context_summarized') {
    const { summaryTokenEstimate, tokenEstimate, upToMessageCount } = event.payload;
    return (
      <div className="space-y-2 text-xs">
        <p>
          Conversation summary stored
          {typeof upToMessageCount === 'number' ? `, covering the first ${upToMessageCount} messages.` : '.'}
        </p>
        <div className="grid grid-cols-2 gap-1.5">
          <div>
            <p className="opacity-70">Compressed estimate</p>
            <p className="font-semibold">{formatTokenCount(tokenEstimate)}</p>
          </div>
          <div>
            <p className="opacity-70">Summary size</p>
            <p className="font-semibold">{formatTokenCount(summaryTokenEstimate)}</p>
          </div>
        </div>
      </div>
    );
  }
  return null;
};

const StatusChip = ({ event }: { event: StatusEvent }) => {
  const [expanded, setExpanded] = useState(false);
  const meta = STATUS_META[event.kind];
  return (
    <div className={cn('rounded-lg border text-xs font-medium overflow-hidden', meta.className)}>
      <button
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:opacity-80 transition-opacity"
        onClick={() => setExpanded((p) => !p)}
        type="button"
      >
        <span aria-hidden="true">{meta.icon}</span>
        <span className="flex-1">{meta.label}</span>
        {expanded
          ? <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          : <ChevronRightIcon className="size-3 shrink-0 opacity-60" />}
      </button>
      {expanded ? (
        <div className="border-t border-current/20 px-2.5 py-2 opacity-90">
          <StatusChipDetail event={event} />
        </div>
      ) : null}
    </div>
  );
};

// ─── Live segments ────────────────────────────────────────────────────────────

type LiveSegment =
  | { kind: 'reasoning'; text: string; isLast: boolean }
  | { kind: 'tool_pair'; call: { toolName: string; input: Record<string, unknown> }; result: { toolName: string; output: Record<string, unknown> } | null; isLast: boolean }
  | { kind: 'text'; text: string }
  | { kind: 'status'; event: StatusEvent };

const buildLiveSegments = (events: LiveEvent[], isStreaming: boolean): LiveSegment[] => {
  const segments: LiveSegment[] = [];
  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.type === 'reasoning') {
      segments.push({ kind: 'reasoning', text: ev.text, isLast: isStreaming && i === events.length - 1 });
      i++;
      continue;
    }
    if (ev.type === 'tool_call') {
      const next = events[i + 1];
      const result = next?.type === 'tool_result'
        ? { toolName: next.toolName, output: next.output } : null;
      const consumed = result ? 2 : 1;
      segments.push({ kind: 'tool_pair', call: { toolName: ev.toolName, input: ev.input }, result, isLast: isStreaming && i + consumed - 1 === events.length - 1 });
      i += consumed;
      continue;
    }
    if (ev.type === 'tool_result') {
      segments.push({ kind: 'tool_pair', call: { toolName: ev.toolName, input: {} }, result: { toolName: ev.toolName, output: ev.output }, isLast: isStreaming && i === events.length - 1 });
      i++;
      continue;
    }
    if (ev.type === 'text') {
      segments.push({ kind: 'text', text: ev.text });
      i++;
      continue;
    }
    if (ev.type === 'status') {
      segments.push({ kind: 'status', event: ev });
      i++;
      continue;
    }
    i++;
  }
  return segments;
};

const LiveConversationContent = memo(function LiveConversationContent({
  liveRunId, liveEvents, showReasoning, streamState,
}: { liveRunId: string | null; liveEvents: LiveEvent[]; showReasoning: boolean; streamState: StreamState }) {
  const isStreaming = streamState === 'streaming';
  if (!liveRunId || liveEvents.length === 0) return null;
  const segments = buildLiveSegments(liveEvents, isStreaming);
  return (
    <Message from="assistant">
      <MessageContent>
        {segments.map((seg, idx) => {
          if (seg.kind === 'reasoning') {
            if (!showReasoning) return null;
            return (
              <Reasoning defaultOpen={true} isStreaming={seg.isLast} key={`reasoning-${idx}`}>
                <ReasoningTrigger />
                <ReasoningStepList text={seg.text} />
              </Reasoning>
            );
          }
          if (seg.kind === 'tool_pair') {
            return (
              <ToolActivityGroup
                entries={[{ input: seg.call.input, output: seg.result?.output ?? null, toolName: seg.result?.toolName ?? seg.call.toolName }]}
                isStreaming={seg.isLast}
                key={`tool-${idx}`}
              />
            );
          }
          if (seg.kind === 'text' && seg.text.trim()) {
            return <MessageResponse key={`text-${idx}`}>{seg.text}</MessageResponse>;
          }
          if (seg.kind === 'status') {
            return <StatusChip event={seg.event} key={`status-${idx}-${seg.event.kind}`} />;
          }
          return null;
        })}
      </MessageContent>
    </Message>
  );
});

// ─── Message Queue Panel ──────────────────────────────────────────────────────

const MessageQueuePanel = memo(function MessageQueuePanel({
  queue, isBusy, onSteer, onRemove, onReorder,
}: {
  queue: QueuedMessage[];
  isBusy: boolean;
  onSteer: (id: string) => Promise<void>;
  onRemove: (id: string) => void;
  onReorder: (from: number, to: number) => void;
}) {
  const dragIndexRef = useRef<number | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className="border-t border-border/60 px-3 py-2">
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground uppercase tracking-wide">
        <span className="size-1.5 rounded-full bg-blue-500/60" />
        Queued ({queue.length}) — auto-sends when idle
      </p>
      <div className="space-y-1">
        {queue.map((msg, index) => (
          <div
            className="group flex items-center gap-1.5 rounded-lg border border-border/50 bg-muted/25 px-2 py-1.5 transition-colors hover:bg-muted/40"
            draggable
            key={msg.id}
            onDragEnd={() => { dragIndexRef.current = null; }}
            onDragOver={(e) => {
              e.preventDefault();
              const from = dragIndexRef.current;
              if (from !== null && from !== index) { onReorder(from, index); dragIndexRef.current = index; }
            }}
            onDragStart={() => { dragIndexRef.current = index; }}
          >
            <GripVerticalIcon className="size-3.5 shrink-0 cursor-grab text-muted-foreground/40 group-hover:text-muted-foreground/70 active:cursor-grabbing" />
            <span className="min-w-0 flex-1 truncate text-xs">{msg.text}</span>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                className="size-6 p-0 text-blue-500 hover:bg-blue-500/10"
                onClick={() => { void onSteer(msg.id); }}
                size="icon-sm"
                title={isBusy ? "Steer active run" : "Send now"}
                variant="ghost"
              >
                <ArrowRightIcon className="size-3" />
              </Button>
              <Button
                className="size-6 p-0 text-destructive hover:bg-destructive/10"
                onClick={() => onRemove(msg.id)}
                size="icon-sm"
                title="Remove from queue"
                variant="ghost"
              >
                <XIcon className="size-3" />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
});

// ─── Main component ───────────────────────────────────────────────────────────

export function AgentChatPanel({
  loading,
  timeline,
  messages,
  hasMoreMessages,
  loadingOlderMessages,
  streamState,
  agentStatus,
  isBusy,
  isCancelling,
  liveRunStatus,
  liveRunId,
  liveEvents,
  activeConversationId,
  streamError,
  error,
  messageQueue,
  onStartRun,
  onCancelRun,
  onLoadOlderMessages,
  onViewChats,
  onEnqueueMessage,
  onDequeueMessage,
  onReorderQueue,
  onSteerWithMessage,
}: AgentChatPanelProps) {
  const [renderWindow, setRenderWindow] = useState(MESSAGE_VIRTUAL_WINDOW);
  const [showReasoning, setShowReasoning] = useState(true);

  const latestSummary = timeline?.latestSummary ?? null;
  const totalMessageCount = timeline?.messageCount ?? messages.length;
  const contextSummary =
    timeline?.contextSummary ??
    fallbackContextSummary({
      latestSummary,
      messagesLength: messages.length,
      totalMessageCount,
    });
  const hasSummary = contextSummary.summaryCount > 0;
  const contextCoveragePercent = contextSummary.compressionPercent;
  const latestSummaryEvent = liveEvents.findLast(
    (event) =>
      event.type === 'status' &&
      (event.kind === 'context_summarizing' || event.kind === 'context_summarized'),
  );
  const isSummarizing =
    latestSummaryEvent?.type === 'status' &&
    latestSummaryEvent.kind === 'context_summarizing' &&
    isBusy;
  const composerDisabled = !activeConversationId || isCancelling;

  const visibleMessages = useMemo(() => {
    if (messages.length <= renderWindow) return messages;
    return messages.slice(messages.length - renderWindow);
  }, [messages, renderWindow]);

  const hiddenLoadedCount = Math.max(0, messages.length - visibleMessages.length);
  const handleRenderOlderLoaded = useCallback(() => {
    setRenderWindow((prev) => prev + MESSAGE_VIRTUAL_WINDOW);
  }, []);

  return (
    <Card className="flex h-full min-h-0 flex-col overflow-hidden border-border/70 bg-card/80" size="sm">
      <CardHeader className="border-b border-border/70 pb-2.5">
        <CardTitle className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-1.5">
            {onViewChats ? (
              <Button onClick={onViewChats} size="icon-sm" title="Back to all chats" type="button" variant="ghost">
                <ListIcon className="size-4" />
              </Button>
            ) : null}
            <span className="text-base">Agent Chat</span>
          </div>
          <div className="flex items-center gap-1.5">
            {isBusy ? (
              <span className="flex items-center gap-1.5 text-xs font-medium text-blue-500">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-blue-500 opacity-75" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-blue-500" />
                </span>
                {AGENT_STATUS_LABELS[agentStatus]}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                Idle
              </span>
            )}
          </div>
        </CardTitle>
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
                  liveEvents={liveEvents}
                  liveRunId={liveRunId}
                  showReasoning={showReasoning}
                  streamState={streamState}
                />
              </ConversationContent>
              <ConversationScrollButton />
            </Conversation>

            <MessageQueuePanel
              isBusy={isBusy}
              onRemove={onDequeueMessage}
              onReorder={onReorderQueue}
              onSteer={onSteerWithMessage}
              queue={messageQueue}
            />

            <div className="border-t border-border/70 p-3">
              <PromptInput
                onSubmit={({ files, text }) => {
                  if (isBusy) {
                    onEnqueueMessage(text);
                    return;
                  }
                  void onStartRun({ files, reasoning: showReasoning ? 'on' : 'off', text });
                }}
              >
                <PromptInputBody>
                  <ComposerAttachments />
                  <PromptInputTextarea
                    className="max-h-40 min-h-12"
                    disabled={isCancelling}
                    placeholder={isBusy ? 'Type to queue a follow-up message…' : 'Describe what to do on the desktop…'}
                  />
                </PromptInputBody>
                <PromptInputFooter className="items-end gap-1.5">
                  <PromptInputTools className="gap-1.5">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger disabled={composerDisabled || isBusy} tooltip="Attach files" />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                        <PromptInputActionAddScreenshot />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>

                    <PromptInputButton
                      aria-label={showReasoning ? 'Reasoning enabled' : 'Reasoning disabled'}
                      className={cn(
                        showReasoning
                          ? 'bg-amber-500/18 text-amber-700 ring-1 ring-amber-500/30 hover:bg-amber-500/26 dark:text-amber-300'
                          : undefined,
                      )}
                      disabled={isBusy}
                      onClick={() => setShowReasoning((prev) => !prev)}
                      tooltip={showReasoning ? 'Reasoning mode: on' : 'Reasoning mode: off'}
                    >
                      <BrainIcon className="size-4" />
                    </PromptInputButton>
                  </PromptInputTools>
                  <div className="flex items-center gap-1">
                    <PromptInputSubmit
                      aria-label={isBusy ? 'Queue message' : 'Submit prompt'}
                      className={cn(
                        'shrink-0',
                        isBusy && !isCancelling
                          ? 'bg-primary/10 text-primary ring-1 ring-primary/30 hover:bg-primary/20'
                          : undefined,
                      )}
                      disabled={composerDisabled}
                      status="ready"
                    >
                      {isBusy && !isCancelling ? (
                        <ListPlusIcon className="size-4" />
                      ) : (
                        <SendIcon className="size-4" />
                      )}
                    </PromptInputSubmit>
                    {isBusy && (
                      <Button
                        aria-label="Cancel run"
                        className="size-8 shrink-0 bg-destructive p-0 text-destructive-foreground hover:bg-destructive/90"
                        disabled={isCancelling}
                        onClick={() => { void onCancelRun(); }}
                        size="icon-xs"
                        type="button"
                      >
                        <XIcon className="size-4" />
                      </Button>
                    )}
                  </div>
                </PromptInputFooter>
              </PromptInput>

              <div className="mt-1.5 flex justify-end">
                <PromptInputHoverCard>
                  <PromptInputHoverCardTrigger>
                    <Button aria-label="View context summary details" className="size-5 p-0" size="icon-xs" type="button" variant="ghost">
                      <SummaryContextIcon hasSummary={hasSummary || isSummarizing} percent={contextSummary.usagePercent || contextCoveragePercent} />
                    </Button>
                  </PromptInputHoverCardTrigger>
                  <PromptInputHoverCardContent align="end" className="w-96 p-3">
                    <ContextSummaryHoverCard
                      contextSummary={contextSummary}
                      isBusy={isBusy}
                      isCancelling={isCancelling}
                      isSummarizing={isSummarizing}
                      latestSummary={latestSummary}
                      liveRunStatus={liveRunStatus}
                      summaryHistory={timeline?.summaryHistory ?? []}
                    />
                  </PromptInputHoverCardContent>
                </PromptInputHoverCard>
              </div>

              {streamError ? <p className="mt-2 text-destructive text-xs">{streamError}</p> : null}
              {error ? <p className="mt-2 text-destructive text-xs">{error}</p> : null}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
