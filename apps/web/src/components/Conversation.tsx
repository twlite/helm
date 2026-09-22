import { memo, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { LiveActivity, Message, RunDetails, StreamingAssistantMessage, Thread } from '../types';
import { formatTime } from '../format';
import { Icon } from './Icon';
import { RunErrorCard } from './RunErrorCard';
import { RunActivityFeed } from './RunActivityFeed';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
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
  liveActivity?: LiveActivity;
  isRetryingRun: boolean;
  onCancelRun: (runId: string) => Promise<void>;
  onRetryRun: (runId?: string) => Promise<void>;
  onOpenActivity: (runId?: string) => void;
  onOpenMobileSidebar: () => void;
  notice: ConversationNotice | null;
  onDismissNotice: () => void;
  isRunActive: boolean;
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

const MessageRow = memo(function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  return (
    <article className={`flex min-w-0 w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={[
          'min-w-0',
          isUser
            ? 'max-w-[min(80%,680px)] rounded-2xl rounded-br-md bg-[#1a222b] px-4 py-3'
            : isAssistant
              ? 'max-w-[780px]'
              : 'max-w-[780px] border-l border-teal-400/30 pl-4',
        ].join(' ')}
      >
        <div className={`mb-2 flex items-center gap-2 text-xs ${isUser ? 'justify-end text-[#aeb7c1]' : 'text-[#79838f]'}`}>
          <span className={`flex size-5 items-center justify-center rounded-full ${isUser ? 'bg-white/[0.08]' : 'bg-teal-400/10 text-teal-300'}`}>
            {roleIcon(message.role)}
          </span>
          <span className="font-medium">{roleLabel(message.role)}</span>
          <time className="text-[11px] text-[#606975]" dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
        </div>
        <p className={`whitespace-pre-wrap break-words text-sm leading-6 ${isUser ? 'text-[#e7ebef]' : 'text-[#d7dde3]'}`}>
          {message.content}
        </p>
      </div>
    </article>
  );
});

function TypingIndicator({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-[#929aa5]" role="status" aria-live="polite">
      <span className="flex size-5 items-center justify-center rounded-full bg-teal-400/10 text-teal-300">
        <Icon className="animate-pulse" name="spark" size={13} />
      </span>
      <span>{label}</span>
      <span className="flex items-center gap-0.5" aria-hidden="true">
        <span className="size-1 animate-bounce rounded-full bg-teal-300 [animation-delay:-0.2s]" />
        <span className="size-1 animate-bounce rounded-full bg-teal-300 [animation-delay:-0.1s]" />
        <span className="size-1 animate-bounce rounded-full bg-teal-300" />
      </span>
    </div>
  );
}

function StreamingMessage({ message }: { message: StreamingAssistantMessage }) {
  return (
    <article className="flex min-w-0 w-full justify-start" aria-live="polite">
      <div className="min-w-0 max-w-[780px]">
        <div className="mb-2 flex items-center gap-2 text-xs text-[#79838f]">
          <span className="flex size-5 items-center justify-center rounded-full bg-teal-400/10 text-teal-300">
            <Icon name="spark" size={14} />
          </span>
          <span className="font-medium">Helm</span>
          <span className="text-[11px] text-teal-300">{message.status === 'writing' ? 'writing…' : 'ready'}</span>
        </div>
        {message.content ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#d7dde3]">
            {message.content}<span className="ml-1 inline-block h-4 w-0.5 animate-pulse bg-teal-300 align-[-2px]" aria-hidden="true" />
          </p>
        ) : (
          <TypingIndicator label="Helm is writing…" />
        )}
      </div>
    </article>
  );
}

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
  liveActivity,
  isRetryingRun,
  onCancelRun,
  onRetryRun,
  onOpenActivity,
  onOpenMobileSidebar,
  notice,
  onDismissNotice,
  isRunActive,
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

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[#0b0d10]">
      <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 sm:px-7">
        <div className="flex min-w-0 items-center gap-2.5">
          <Button aria-label="Open threads" className="md:hidden" onClick={onOpenMobileSidebar} size="icon-sm" variant="ghost">
            <Icon name="menu" size={17} />
          </Button>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-semibold text-[#f1f3f5]">{thread?.title ?? 'Helm'}</h1>
            <p className="mt-0.5 truncate text-xs text-[#606975]">{thread ? 'Local agent workspace' : 'What do you want to do?'}</p>
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
          <div className="mx-auto flex min-h-full min-w-0 w-full max-w-[950px] flex-col px-5 py-8 sm:px-10 sm:py-10">
            {!thread ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <div className="max-w-md text-center">
                  <div className="mx-auto mb-5 flex size-10 items-center justify-center rounded-xl bg-teal-400/10 text-sm font-semibold text-teal-300">H</div>
                  <h2 className="text-xl font-semibold tracking-[-0.02em] text-[#f1f3f5]">What do you want to do?</h2>
                  <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#79838f]">Ask Helm to browse, edit files, or work inside its desktop.</p>
                </div>
              </div>
            ) : (
              <div className="flex min-w-0 flex-col gap-8">
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
                {streamingAssistant?.threadId === thread.id ? <StreamingMessage message={streamingAssistant} /> : null}
                {isRunActive && !streamingAssistant ? (
                  <TypingIndicator label={run?.criteria.length ? 'Helm is working…' : 'Helm is thinking…'} />
                ) : null}
                {run && (run.criteria.length > 0 || run.status !== 'completed') ? (
                  <div className="min-w-0 max-w-[780px]">
                    <RunActivityFeed
                      isRetryingRun={isRetryingRun}
                      liveActivity={liveActivity}
                      onCancelRun={onCancelRun}
                      onRetryRun={onRetryRun}
                      run={run}
                      showError={false}
                    />
                  </div>
                ) : null}
              </div>
            )}
          </div>
        </ScrollArea>
      </div>

      <div className="shrink-0 px-5 pb-5 pt-3 sm:px-10 sm:pb-7">
        <div className="mx-auto w-full max-w-[850px]">
          {notice ? (
            <Alert className={`mb-3 flex items-start justify-between gap-3 ${notice.tone === 'error' ? 'border-red-400/20 bg-red-400/[0.06] text-red-200' : 'border-teal-400/20 bg-teal-400/[0.06] text-teal-200'}`}>
              <span className="min-w-0 text-xs leading-5">{notice.message}</span>
              <Button aria-label="Dismiss notification" className="-mr-1 -mt-1 text-current hover:bg-white/[0.06]" onClick={onDismissNotice} size="icon-sm" variant="ghost">
                <Icon name="x" size={14} />
              </Button>
            </Alert>
          ) : null}
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="rounded-2xl border border-white/[0.1] bg-[#11151b] shadow-xl shadow-black/10 transition-colors focus-within:border-teal-400/45">
              <label className="sr-only" htmlFor="message-composer">Message</label>
              <Textarea
                className="min-h-[78px] resize-none rounded-none border-0 bg-transparent px-4 pb-2 pt-4 shadow-none focus:border-0 focus:ring-0"
                disabled={isSending}
                id="message-composer"
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask Helm to do something…"
                rows={2}
                value={draft}
              />
              <div className="flex flex-wrap items-center justify-between gap-3 px-3 pb-3">
                <Button aria-label="Connected model" className="h-7 px-2 text-[11px] text-[#aeb7c1]" disabled={isSending} size="sm" variant="ghost">
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
