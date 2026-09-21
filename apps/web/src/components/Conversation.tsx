import { memo } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import type { Message, RunDetails, Thread } from '../types';
import { formatTime } from '../format';
import { Icon } from './Icon';
import { Alert } from './ui/alert';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Textarea } from './ui/textarea';

export type ConversationNotice = {
  tone: 'error' | 'info';
  message: string;
};

type ConversationProps = {
  thread: Thread | null;
  messages: Message[];
  isLoading: boolean;
  draft: string;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSend: (content: string) => Promise<void>;
  onRunDemo: () => Promise<void>;
  isRunStarting: boolean;
  run: RunDetails | null;
  activityOpen: boolean;
  onToggleActivity: () => void;
  onOpenMobileSidebar: () => void;
  notice: ConversationNotice | null;
  onDismissNotice: () => void;
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

const MessageRow = memo(function MessageRow({ message }: { message: Message }) {
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  return (
    <article className={`flex w-full ${isUser ? 'justify-end' : 'justify-start'}`}>
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

function RunStatus({ run, open, onToggle }: { run: RunDetails | null; open: boolean; onToggle: () => void }) {
  return (
    <Button
      aria-label="Open agent activity"
      className={open ? 'bg-white/[0.08] text-[#f1f3f5]' : undefined}
      onClick={onToggle}
      size="sm"
      variant="ghost"
    >
      <Icon name="activity" size={15} />
      <span className="hidden sm:inline">Activity</span>
      {run ? (
        <span className={`size-1.5 rounded-full ${run.status === 'running' || run.status === 'pending' ? 'bg-teal-300' : run.status === 'completed' ? 'bg-emerald-300' : 'bg-amber-300'}`} />
      ) : null}
    </Button>
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
  activityOpen,
  onToggleActivity,
  onOpenMobileSidebar,
  notice,
  onDismissNotice,
}: ConversationProps) {
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || isSending || !thread) {
      return;
    }
    await onSend(content);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col bg-[#0b0d10]">
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
          <RunStatus onToggle={onToggleActivity} open={activityOpen} run={run} />
        </div>
      </header>

      <div className="min-h-0 flex-1">
        <ScrollArea className="h-full">
          <div className="mx-auto flex min-h-full w-full max-w-[950px] flex-col px-5 py-8 sm:px-10 sm:py-10">
            {!thread ? (
              <div className="flex flex-1 items-center justify-center py-16">
                <div className="max-w-md text-center">
                  <div className="mx-auto mb-5 flex size-10 items-center justify-center rounded-xl bg-teal-400/10 text-sm font-semibold text-teal-300">H</div>
                  <h2 className="text-xl font-semibold tracking-[-0.02em] text-[#f1f3f5]">What do you want to do?</h2>
                  <p className="mx-auto mt-3 max-w-sm text-sm leading-6 text-[#79838f]">Ask Helm to browse, edit files, or work inside its desktop.</p>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-8">
                {isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-[#79838f]">
                    <span className="size-1.5 animate-pulse rounded-full bg-teal-300" />
                    Loading messages…
                  </div>
                ) : messages.length > 0 ? (
                  messages.map((message) => <MessageRow key={message.id} message={message} />)
                ) : (
                  <div className="py-16 text-center">
                    <p className="text-sm font-medium text-[#aeb7c1]">Start with an instruction</p>
                    <p className="mt-2 text-sm text-[#606975]">Your messages and agent work will appear here.</p>
                  </div>
                )}
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
                disabled={!thread || isSending}
                id="message-composer"
                onChange={(event) => onDraftChange(event.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={thread ? 'Ask Helm to do something…' : 'Create a thread to begin…'}
                rows={2}
                value={draft}
              />
              <div className="flex items-center justify-between gap-3 px-3 pb-3">
                {thread ? (
                  <Button aria-label="Connected model" className="h-7 px-2 text-[11px] text-[#aeb7c1]" disabled={isSending} size="sm" variant="ghost">
                    <Icon name="spark" size={13} />
                    Gemma
                  </Button>
                ) : <span className="truncate text-xs text-[#606975]">No thread selected</span>}
                <Button aria-label="Send message" disabled={!thread || !draft.trim() || isSending} size="icon-sm" type="submit">
                  {isSending ? <Icon className="animate-spin" name="refresh" size={15} /> : <Icon name="arrow-up" size={16} />}
                </Button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </main>
  );
}
