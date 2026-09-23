import { memo, useEffect, useRef, useState } from 'react';
import type { ComponentPropsWithoutRef, FormEvent, KeyboardEvent, Ref } from 'react';
import {
  extractTableDataFromElement,
  Streamdown,
  tableDataToCSV,
  tableDataToMarkdown,
} from 'streamdown';
import type { Components, ExtraProps } from 'streamdown';
import type { ChatProgress, Message, RunDetails, StreamingAssistantMessage, Thread } from '../types';
import { formatTime } from '../format';
import { Icon } from './Icon';
import { RunErrorCard } from './RunErrorCard';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { ScrollArea } from './ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { Textarea } from './ui/textarea';

export type ConversationNotice = {
  tone: 'error' | 'info';
  message: string;
};

export type ConversationSendMode = 'start' | 'queue' | 'steer';

type ConversationProps = {
  thread: Thread | null;
  messages: Message[];
  isLoading: boolean;
  draft: string;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSend: (content: string, mode: ConversationSendMode) => Promise<void>;
  onRunDemo: () => Promise<void>;
  isRunStarting: boolean;
  run: RunDetails | null;
  isRetryingRun: boolean;
  onCancelRun: (runId: string) => Promise<void>;
  onRetryRun: (runId?: string) => Promise<void>;
  onOpenActivity: (runId?: string) => void;
  onOpenMobileSidebar: () => void;
  notice: ConversationNotice | null;
  onDismissNotice: () => void;
  isRunActive: boolean;
  chatProgress?: ChatProgress | null;
  isStoppingRun?: boolean;
  streamingAssistant?: StreamingAssistantMessage | null;
};

function roleLabel(role: Message['role']): string {
  switch (role) {
    case 'user':
      return 'You';
    case 'assistant':
      return 'Helm';
    case 'tool':
      return 'Tool';
    case 'system':
      return 'System';
  }
}

function roleIcon(role: Message['role']) {
  if (role === 'user') {
    return <span className="text-[11px] font-semibold text-[#aeb7c1]">Y</span>;
  }
  return <Icon name={role === 'assistant' ? 'spark' : role === 'tool' ? 'activity' : 'server'} size={14} />;
}

function metadataString(message: Message, key: string): string | undefined {
  const value = message.metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function isRunErrorMessage(message: Message): boolean {
  if (message.role !== 'assistant' || metadataString(message, 'source') !== 'ai-run') {
    return false;
  }
  return ['failed', 'blocked', 'cancelled'].includes(metadataString(message, 'status') ?? '');
}

function runErrorTitle(status: string | undefined): string {
  switch (status) {
    case 'blocked':
      return 'Task blocked';
    case 'cancelled':
      return 'Task stopped';
    default:
      return 'Task failed';
  }
}

const MARKDOWN_CLASS = [
  'min-w-0 max-w-none break-words text-[13px] leading-[1.65] [overflow-wrap:anywhere]',
  '[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-[#f1f3f5]',
  '[&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-[#f1f3f5]',
  '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-[#f1f3f5]',
  '[&_p]:my-2 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0',
  '[&_ul]:my-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-2 [&_ol]:list-decimal [&_ol]:pl-5',
  '[&_li]:my-1',
  '[&_a]:text-teal-300 [&_a]:underline [&_a]:underline-offset-2 hover:[&_a]:text-teal-200',
  '[&_blockquote]:my-3 [&_blockquote]:border-l-2 [&_blockquote]:border-teal-400/40 [&_blockquote]:pl-3 [&_blockquote]:text-[#aeb7c1]',
  '[&_hr]:my-4 [&_hr]:border-white/[0.08]',
  '[&_pre]:my-3 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded-[4px] [&_pre]:border [&_pre]:border-[var(--border)] [&_pre]:bg-[var(--pane-bg)] [&_pre]:p-3',
  '[&_code]:rounded-[3px] [&_code]:bg-white/[0.06] [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.9em] [&_code]:text-[var(--text)]',
  '[&_pre_code]:bg-transparent [&_pre_code]:p-0',
  '[&_img]:max-w-full [&_img]:rounded-lg',
].join(' ');

type MarkdownTableProps = ComponentPropsWithoutRef<'table'> & ExtraProps;
type MarkdownTableSectionProps = ComponentPropsWithoutRef<'thead'> & ExtraProps;
type MarkdownTableRowProps = ComponentPropsWithoutRef<'tr'> & ExtraProps;
type MarkdownTableCellProps = ComponentPropsWithoutRef<'th'> & ExtraProps;
type MarkdownTableDataCellProps = ComponentPropsWithoutRef<'td'> & ExtraProps;

function MarkdownTableHeader({ node: _node, ...props }: MarkdownTableSectionProps) {
  return <TableHeader {...props} />;
}

function MarkdownTableBody({ node: _node, ...props }: ComponentPropsWithoutRef<'tbody'> & ExtraProps) {
  return <TableBody {...props} />;
}

function MarkdownTableRow({ node: _node, ...props }: MarkdownTableRowProps) {
  return <TableRow {...props} />;
}

function MarkdownTableHead({ node: _node, ...props }: MarkdownTableCellProps) {
  return <TableHead {...props} />;
}

function MarkdownTableCell({ node: _node, ...props }: MarkdownTableDataCellProps) {
  return <TableCell {...props} />;
}

function downloadTable(table: HTMLTableElement) {
  const data = extractTableDataFromElement(table);
  const blob = new Blob([tableDataToCSV(data)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'helm-table.csv';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

const MarkdownTable = memo(function MarkdownTable({
  children,
  className,
  node: _node,
  ...props
}: MarkdownTableProps) {
  const tableRef = useRef<HTMLTableElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  async function copyTable() {
    if (!tableRef.current || !navigator.clipboard) return;
    try {
      const data = extractTableDataFromElement(tableRef.current);
      await navigator.clipboard.writeText(tableDataToMarkdown(data));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  }

  function tableMarkup(tableClassName: string, ref?: Ref<HTMLTableElement>) {
    return (
      <Table
        {...props}
        className={`min-w-[34rem] text-left text-xs ${tableClassName} ${className ?? ''}`}
        ref={ref}
      >
        {children}
      </Table>
    );
  }

  return (
    <>
      <section className="my-4 min-w-0 overflow-hidden rounded-lg border border-[var(--border-strong)] bg-[var(--pane-raised)]">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-3 py-2">
          <span className="text-[11px] font-medium text-[var(--text-muted)]">Table</span>
          <div className="flex items-center gap-0.5">
            <Button aria-label={copied ? 'Table copied' : 'Copy table as Markdown'} onClick={() => void copyTable()} size="icon-sm" variant="ghost">
              <Icon name={copied ? 'check' : 'copy'} size={14} />
            </Button>
            <Button aria-label="Download table as CSV" onClick={() => tableRef.current && downloadTable(tableRef.current)} size="icon-sm" variant="ghost">
              <Icon name="download" size={14} />
            </Button>
            <Button aria-label="Expand table" onClick={() => setExpanded(true)} size="icon-sm" variant="ghost">
              <Icon name="maximize" size={14} />
            </Button>
          </div>
        </div>
        <div className="max-h-[22rem] overflow-auto p-1.5">
          {tableMarkup('rounded-md border border-[var(--border)]', tableRef)}
        </div>
      </section>

      <Dialog onOpenChange={setExpanded} open={expanded}>
        <DialogContent className="flex h-[min(90vh,760px)] max-w-[min(1200px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0">
          <DialogHeader className="shrink-0 border-b border-[var(--border)] px-5 py-4 pr-12">
            <DialogTitle className="text-sm">Expanded table</DialogTitle>
            <DialogDescription className="text-xs">Scroll to view all rows and columns.</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {tableMarkup('min-w-full rounded-md border border-[var(--border)]')}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
});

const MARKDOWN_COMPONENTS: Components = {
  table: MarkdownTable,
  thead: MarkdownTableHeader,
  tbody: MarkdownTableBody,
  tr: MarkdownTableRow,
  th: MarkdownTableHead,
  td: MarkdownTableCell,
};

const MarkdownContent = memo(function MarkdownContent({
  content,
  streaming = false,
  className = '',
}: {
  content: string;
  streaming?: boolean;
  className?: string;
}) {
  return (
    <Streamdown
      className={`${MARKDOWN_CLASS} ${className}`}
      components={MARKDOWN_COMPONENTS}
      lineNumbers={false}
      mode={streaming ? 'streaming' : 'static'}
    >
      {content}
    </Streamdown>
  );
});

const MessageRow = memo(function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  return (
    <article className={`flex min-w-0 w-full [content-visibility:auto] [contain-intrinsic-size:0_96px] ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'min-w-0',
          isUser
            ? 'max-w-[min(78%,680px)] rounded-[6px] border border-[var(--border)] bg-[var(--pane-raised)] px-3 py-2.5'
            : isAssistant
              ? 'max-w-[780px]'
              : 'max-w-[780px] border-l border-teal-400/30 pl-4',
        ].join(' ')}
      >
        <div className={`mb-1.5 flex items-center gap-2 text-[11px] ${isUser ? 'justify-end' : ''}`}>
          {!isUser ? <span className="text-[var(--text-muted)]">{roleIcon(message.role)}</span> : null}
          <span className="font-medium text-[var(--text-secondary)]">{roleLabel(message.role)}</span>
          <time className="text-[10px] tabular-nums text-[var(--text-muted)]" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </div>
        <MarkdownContent
          className={isUser ? 'text-[var(--text)] [&_p]:whitespace-pre-wrap' : 'text-[#d2d7dc]'}
          content={message.content}
        />
      </div>
    </article>
  );
});

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]" role="status" aria-live="polite">
      <Icon className="animate-pulse text-[var(--accent)]" name="spark" size={13} />
      <span>{label}</span>
    </div>
  );
}

function toolInputPreview(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const sensitive = /password|secret|token|authorization|cookie|credential|api.?key|content|text|body|base64|bytes|data/iu;
  const entries = Object.entries(input).slice(0, 4).map(([key, value]) => {
    if (sensitive.test(key)) return `${key}: hidden`;
    let rendered: string;
    if (typeof value === 'string') {
      if (key.toLowerCase() === 'url') {
        try {
          const url = new URL(value);
          rendered = `${url.origin}${url.pathname}${url.search ? '?…' : ''}`;
        } catch {
          rendered = value.split(/[?#]/u, 1)[0].slice(0, 72);
        }
      } else {
        rendered = value.slice(0, 72);
      }
    } else if (value === null || typeof value === 'number' || typeof value === 'boolean') {
      rendered = String(value);
    } else if (Array.isArray(value)) {
      rendered = `[${value.length} items]`;
    } else if (typeof value === 'object') {
      rendered = '{…}';
    } else {
      rendered = String(value);
    }
    return `${key}: ${rendered}`;
  });
  return entries.length > 0 ? entries.join(' · ') : undefined;
}

const ChatProgressPanel = memo(function ChatProgressPanel({
  progress,
  runId,
  isRunActive,
  hasAssistantResponse,
}: {
  progress: ChatProgress | null;
  runId?: string;
  isRunActive: boolean;
  hasAssistantResponse: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const toolCalls = progress?.toolCalls ?? [];
  const summaries = progress?.summaries ?? [];

  useEffect(() => {
    setExpanded(!hasAssistantResponse);
  }, [runId, hasAssistantResponse]);

  if (!isRunActive && toolCalls.length === 0 && summaries.length === 0) return null;

  const latestSummary = summaries.at(-1);
  return (
    <section className="max-w-[780px] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--pane-raised)]/60">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        <Icon className={isRunActive ? 'animate-pulse text-[var(--accent)]' : 'text-[var(--text-muted)]'} name="spark" size={13} />
        <span className="shrink-0 text-xs font-medium text-[var(--text-secondary)]">Helm progress</span>
        {latestSummary && !expanded ? (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-muted)]">{latestSummary}</span>
        ) : (
          <span className="min-w-0 flex-1 text-[11px] text-[var(--text-muted)]">
            {isRunActive ? 'Working' : `${toolCalls.length} tool call${toolCalls.length === 1 ? '' : 's'}`}
          </span>
        )}
        <Icon className={`shrink-0 text-[var(--text-muted)] transition-transform ${expanded ? 'rotate-180' : ''}`} name="chevron-down" size={13} />
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-[var(--border)] px-3 py-2.5" aria-live="polite">
          {summaries.map((summary, index) => (
            <p className="border-l border-[var(--border-strong)] pl-2.5 text-xs leading-5 text-[var(--text-muted)]" key={`${index}-${summary}`}>
              {summary}
            </p>
          ))}
          {toolCalls.map((call) => {
            const preview = toolInputPreview(call.input);
            const statusLabel = call.status === 'running' ? 'Running' : call.status === 'failed' ? 'Failed' : 'Done';
            return (
              <div className="flex min-w-0 items-start gap-2 text-xs" key={call.stepIndex}>
                {call.status === 'running' ? (
                  <span className="mt-1 size-2 shrink-0 animate-pulse rounded-full bg-[var(--accent)]" aria-hidden="true" />
                ) : (
                  <Icon className={`mt-0.5 shrink-0 ${call.status === 'failed' ? 'text-[var(--danger)]' : 'text-emerald-400'}`} name={call.status === 'failed' ? 'x' : 'check'} size={12} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <code className="font-mono text-[11px] text-[var(--text-secondary)]">{call.toolName}</code>
                    <span className="text-[10px] text-[var(--text-muted)]">{statusLabel}</span>
                  </div>
                  {preview ? <p className="mt-0.5 break-words text-[10px] leading-4 text-[var(--text-muted)]">{preview}</p> : null}
                </div>
              </div>
            );
          })}
          {isRunActive && toolCalls.length === 0 && summaries.length === 0 ? (
            <TypingIndicator label="Helm is preparing the next step…" />
          ) : null}
        </div>
      ) : null}
    </section>
  );
});

const StreamingMessage = memo(function StreamingMessage({ message }: { message: StreamingAssistantMessage }) {
  return (
    <article className="flex min-w-0 w-full justify-start" aria-live="polite">
      <div className="min-w-0 max-w-[780px]">
        <div className="mb-2 flex items-center gap-2 text-xs text-[#79838f]">
          <Icon className="text-[var(--accent)]" name="spark" size={13} />
          <span className="font-medium">Helm</span>
          <span className="text-[11px] text-teal-300">{message.status === 'writing' ? 'writing…' : 'ready'}</span>
        </div>
        {message.content ? (
          <div className="relative min-w-0 text-[#d7dde3]">
            <MarkdownContent content={message.content} streaming />
            <span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-teal-300 align-[-2px]" aria-hidden="true" />
          </div>
        ) : (
          <TypingIndicator label="Helm is writing…" />
        )}
      </div>
    </article>
  );
});

export function Conversation({
  thread,
  messages,
  isLoading,
  draft,
  isSending,
  onDraftChange,
  onSend,
  onRunDemo,
  isRunStarting,
  run,
  isRetryingRun,
  onCancelRun,
  onRetryRun,
  onOpenActivity,
  onOpenMobileSidebar,
  notice,
  onDismissNotice,
  isRunActive,
  chatProgress = null,
  isStoppingRun = false,
  streamingAssistant = null,
}: ConversationProps) {
  const [sendMode, setSendMode] = useState<Exclude<ConversationSendMode, 'start'>>('queue');

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isSending) {
      return;
    }
    await onSend(content, isRunActive ? sendMode : 'start');
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  const currentProgress = chatProgress?.runId === run?.id ? chatProgress : null;

  return (
    <main className="flex min-w-[420px] flex-1 flex-col overflow-hidden bg-[var(--app-bg)]">
      <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-[var(--border)] px-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button aria-label="Open threads" className="md:hidden" onClick={onOpenMobileSidebar} size="icon-sm" variant="ghost">
            <Icon name="menu" size={17} />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-[13px] font-semibold text-[var(--text)]">{thread?.title ?? 'New thread'}</h1>
            {thread ? <p className="truncate text-[10px] text-[var(--text-muted)]">Agent workspace</p> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {thread ? (
            <Button aria-label={isRunStarting ? 'Starting scripted demo' : 'Run scripted demo'} disabled={isRunStarting} onClick={() => void onRunDemo()} size="sm" variant="ghost">
              <Icon name="play" size={14} />
              <span className="hidden sm:inline">{isRunStarting ? 'Starting…' : 'Demo'}</span>
            </Button>
          ) : null}
        </div>
      </header>

      <div className="min-h-0 min-w-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto flex min-h-full min-w-0 w-full max-w-[1040px] flex-col px-5 py-5 sm:px-7 sm:py-6 xl:px-9">
            {!thread ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <div className="max-w-md text-center">
                  <Icon className="mx-auto mb-4 text-[var(--text-muted)]" name="spark" size={22} />
                  <h2 className="text-base font-semibold text-[var(--text)]">What do you want to do?</h2>
                  <p className="mx-auto mt-2 max-w-sm text-xs leading-5 text-[var(--text-muted)]">Ask Helm to browse, edit files, or work inside its desktop.</p>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-5">
                {isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-[#79838f]">
                    <span className="size-1.5 animate-pulse rounded-full bg-teal-300" />
                    Loading messages…
                  </div>
                ) : messages.length > 0 ? (
                  messages.map((message) => {
                    if (!isRunErrorMessage(message)) {
                      return <MessageRow key={message.id} message={message} />;
                    }
                    const runId = metadataString(message, 'runId');
                    const matchingRun = run?.id === runId ? run : null;
                    const status = metadataString(message, 'status');
                    return (
                      <RunErrorCard
                        code={matchingRun?.error?.code}
                        details={matchingRun?.error?.details}
                        isRetrying={isRetryingRun}
                        key={message.id}
                        message={message.content}
                        onOpenActivity={() => onOpenActivity(runId)}
                        onRetry={() => onRetryRun(runId)}
                        title={runErrorTitle(status)}
                      />
                    );
                  })
                ) : (
                  <div className="py-16 text-center">
                    <p className="text-sm font-medium text-[#aeb7c1]">Start with an instruction</p>
                    <p className="mt-2 text-sm text-[#606975]">Your messages and agent work will appear here.</p>
                  </div>
                )}
                {run?.error && !messages.some((message) => isRunErrorMessage(message) && metadataString(message, 'runId') === run.id) ? (
                  <RunErrorCard
                    code={run.error.code}
                    details={run.error.details}
                    isRetrying={isRetryingRun}
                    message={run.error.message}
                    onOpenActivity={() => onOpenActivity(run.id)}
                    onRetry={() => onRetryRun(run.id)}
                    title={runErrorTitle(run.status)}
                  />
                ) : null}
                <ChatProgressPanel
                  hasAssistantResponse={run?.status === 'completed' || streamingAssistant?.threadId === thread.id}
                  isRunActive={isRunActive}
                  progress={currentProgress}
                  runId={run?.id}
                />
                {streamingAssistant?.threadId === thread.id ? <StreamingMessage message={streamingAssistant} /> : null}
                {isRunActive && !streamingAssistant && !currentProgress ? (
                  <TypingIndicator label="Helm is preparing the next step…" />
                ) : null}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="shrink-0 border-t border-[var(--border)] bg-[var(--pane-bg)] px-4 py-3 sm:px-6">
        <div className="mx-auto w-full max-w-[960px]">
          {notice ? (
            <Alert className={`mb-3 flex items-start justify-between gap-3 ${notice.tone === 'error' ? 'border-red-400/20 bg-red-400/[0.06] text-red-200' : 'border-teal-400/20 bg-teal-400/[0.06] text-teal-200'}`}>
              <span className="min-w-0 text-xs leading-5">{notice.message}</span>
              <Button aria-label="Dismiss notification" className="-mr-1 -mt-1 text-current hover:bg-white/[0.06]" onClick={onDismissNotice} size="icon-sm" variant="ghost">
                <Icon name="x" size={14} />
              </Button>
            </Alert>
          ) : null}
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="rounded-[7px] border border-[var(--border-strong)] bg-[var(--app-bg)] transition-colors focus-within:border-[var(--accent)]">
              <label className="sr-only" htmlFor="message-composer">Message</label>
              <Textarea
                className="max-h-40 min-h-10 resize-none rounded-none border-0 bg-transparent px-3 pb-1 pt-2.5 text-[13px] shadow-none focus:border-0 focus:ring-0"
                disabled={isSending}
                id="message-composer"
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Helm to do something…"
                rows={1}
                value={draft}
              />
              <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
                <Button aria-label="Connected model" className="text-[10px]" disabled={isSending} size="sm" variant="ghost">
                  <Icon name="spark" size={13} />
                  Gemma
                </Button>
                <div className="ml-auto flex items-center gap-1.5">
                  {isRunActive ? (
                    <div className="flex items-center rounded-md bg-white/[0.04] p-0.5" role="group" aria-label="Message delivery mode">
                      <Button
                        aria-pressed={sendMode === 'queue'}
                        className={sendMode === 'queue' ? 'bg-white/[0.08] text-[#f1f3f5]' : 'text-[#79838f]'}
                        onClick={() => setSendMode('queue')}
                        size="sm"
                        variant="ghost"
                      >
                        Queue
                      </Button>
                      <Button
                        aria-pressed={sendMode === 'steer'}
                        className={sendMode === 'steer' ? 'bg-white/[0.08] text-[#f1f3f5]' : 'text-[#79838f]'}
                        onClick={() => setSendMode('steer')}
                        size="sm"
                        variant="ghost"
                      >
                        Steer
                      </Button>
                    </div>
                  ) : null}
                  {isRunActive && run ? (
                    <Button aria-label="Stop run" disabled={isStoppingRun} onClick={() => void onCancelRun(run.id)} size="sm" variant="ghost">
                      <Icon name="square" size={11} />
                      {isStoppingRun ? 'Stopping…' : 'Stop'}
                    </Button>
                  ) : null}
                  <Button aria-label={isRunActive ? (sendMode === 'steer' ? 'Steer Helm' : 'Queue message') : 'Send message'} disabled={!draft.trim() || isSending} size="icon-sm" type="submit">
                    {isSending ? <Icon className="animate-spin" name="refresh" size={15} /> : <Icon name="arrow-up" size={16} />}
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
