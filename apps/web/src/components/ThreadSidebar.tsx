import { useState } from 'react';
import type { FormEvent, KeyboardEvent, MouseEvent } from 'react';
import type { Thread } from '../types';
import { formatDate, formatTime } from '../format';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { ScrollArea } from './ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './ui/sheet';

type ThreadSidebarProps = {
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onCreateThread: (title: string) => Promise<boolean>;
  onDeleteThread: (threadId: string) => Promise<void>;
  isCreating: boolean;
  connectionState: 'connecting' | 'connected' | 'reconnecting' | 'offline';
  reconnectAttempt: number;
  mobileOpen: boolean;
  onMobileOpenChange: (open: boolean) => void;
  onOpenMemory: () => void;
  onOpenSettings: () => void;
};

type SidebarContentProps = Omit<ThreadSidebarProps, 'mobileOpen' | 'onMobileOpenChange'> & {
  onCloseMobile: () => void;
};

function connectionCopy(connectionState: ThreadSidebarProps['connectionState'], reconnectAttempt: number) {
  switch (connectionState) {
    case 'connected':
      return { label: 'Environment ready', tone: 'text-emerald-300', dot: 'bg-emerald-400' };
    case 'reconnecting':
      return { label: `Reconnecting${reconnectAttempt > 0 ? ` · ${reconnectAttempt}` : ''}`, tone: 'text-amber-300', dot: 'bg-amber-400' };
    case 'connecting':
      return { label: 'Connecting', tone: 'text-amber-300', dot: 'bg-amber-400' };
    default:
      return { label: 'Backend disconnected', tone: 'text-red-300', dot: 'bg-red-400' };
  }
}

function isToday(value: string) {
  const date = new Date(value);
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function ThreadRow({
  thread,
  selected,
  onSelect,
  onDelete,
}: {
  thread: Thread;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  }

  function handleDelete(event: MouseEvent<HTMLButtonElement>) {
    event.stopPropagation();
    onDelete();
  }

  return (
    <div
      aria-current={selected ? 'page' : undefined}
      className={`group flex min-w-0 cursor-pointer items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${selected ? 'bg-white/[0.08] text-[#f1f3f5]' : 'text-[#9ba4af] hover:bg-white/[0.045] hover:text-[#e7ebef]'}`}
      onClick={onSelect}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <Icon className="shrink-0 opacity-60" name="message" size={15} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium">{thread.title}</span>
        <span className="mt-0.5 block truncate text-[11px] text-[#606975]">{isToday(thread.updatedAt) ? formatTime(thread.updatedAt) : formatDate(thread.updatedAt)}</span>
      </span>
      <button
        aria-label={`Delete ${thread.title}`}
        className="invisible rounded p-1 text-[#606975] opacity-0 transition hover:bg-red-500/10 hover:text-red-300 group-hover:visible group-hover:opacity-100 focus-visible:visible focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal-400/50"
        onClick={handleDelete}
        type="button"
      >
        <Icon name="trash" size={13} />
      </button>
    </div>
  );
}

function ThreadGroup({
  label,
  threads,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onCloseMobile,
}: {
  label: string;
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => Promise<void>;
  onCloseMobile: () => void;
}) {
  if (threads.length === 0) {
    return null;
  }
  return (
    <section className="space-y-1">
      <h2 className="px-2.5 text-[11px] font-medium text-[#606975]">{label}</h2>
      <div className="space-y-0.5">
        {threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            onDelete={() => void onDeleteThread(thread.id)}
            onSelect={() => {
              onSelectThread(thread.id);
              onCloseMobile();
            }}
            selected={thread.id === selectedThreadId}
            thread={thread}
          />
        ))}
      </div>
    </section>
  );
}

function SidebarContent({
  threads,
  selectedThreadId,
  onSelectThread,
  onCreateThread,
  onDeleteThread,
  isCreating,
  connectionState,
  reconnectAttempt,
  onCloseMobile,
  onOpenMemory,
  onOpenSettings,
}: SidebarContentProps) {
  const [isComposerOpen, setIsComposerOpen] = useState(false);
  const [title, setTitle] = useState('');
  const todayThreads = threads.filter((thread) => isToday(thread.updatedAt));
  const previousThreads = threads.filter((thread) => !isToday(thread.updatedAt));
  const connection = connectionCopy(connectionState, reconnectAttempt);

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!nextTitle || isCreating) {
      return;
    }
    const created = await onCreateThread(nextTitle);
    if (created) {
      setTitle('');
      setIsComposerOpen(false);
      onCloseMobile();
    }
  }

  function closeComposer() {
    setTitle('');
    setIsComposerOpen(false);
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0d1015]">
      <div className="flex items-center gap-2.5 px-4 py-4">
        <div className="flex size-7 items-center justify-center rounded-lg bg-teal-400/10 text-xs font-semibold text-teal-300">H</div>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#f1f3f5]">Helm</p>
          <p className="text-[11px] text-[#606975]">Local agent</p>
        </div>
      </div>

      <div className="px-3">
        {isComposerOpen ? (
          <form className="space-y-2 rounded-lg bg-white/[0.035] p-2" onSubmit={(event) => void handleCreate(event)}>
            <label className="sr-only" htmlFor="new-thread-title">Thread title</label>
            <input
              autoFocus
              className="h-8 w-full rounded-md border border-white/[0.1] bg-[#11151b] px-2.5 text-xs text-[#f1f3f5] outline-none placeholder:text-[#606975] focus:border-teal-400/60 focus:ring-2 focus:ring-teal-400/15"
              id="new-thread-title"
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Name this thread"
              value={title}
            />
            <div className="flex gap-1.5">
              <Button className="flex-1" disabled={!title.trim() || isCreating} size="sm" type="submit">
                {isCreating ? 'Creating…' : 'Create'}
              </Button>
              <Button className="flex-1" onClick={closeComposer} size="sm" variant="ghost" type="button">Cancel</Button>
            </div>
          </form>
        ) : (
          <Button className="w-full justify-start" onClick={() => setIsComposerOpen(true)} size="sm" variant="secondary">
            <Icon name="plus" size={15} />
            New thread
          </Button>
        )}
      </div>

      <ScrollArea className="mt-6 min-h-0 flex-1 px-3">
        <div className="space-y-6 pb-4">
          <div className="flex items-center justify-between px-2.5">
            <h2 className="text-xs font-medium text-[#aeb7c1]">Threads</h2>
            {threads.length > 0 ? <span className="text-[11px] text-[#606975]">{threads.length}</span> : null}
          </div>
          <ThreadGroup label="Today" onCloseMobile={onCloseMobile} onDeleteThread={onDeleteThread} onSelectThread={onSelectThread} selectedThreadId={selectedThreadId} threads={todayThreads} />
          <ThreadGroup label="Previous" onCloseMobile={onCloseMobile} onDeleteThread={onDeleteThread} onSelectThread={onSelectThread} selectedThreadId={selectedThreadId} threads={previousThreads} />
          {threads.length === 0 ? (
            <p className="px-2.5 text-xs leading-5 text-[#606975]">Your saved conversations will appear here.</p>
          ) : null}
        </div>
      </ScrollArea>

      <div className="space-y-1 border-t border-white/[0.06] px-3 py-3">
        <Button className="w-full justify-start" onClick={() => { onOpenMemory(); onCloseMobile(); }} size="sm" variant="ghost">
          <Icon name="memory" size={15} />
          Memory
        </Button>
        <Button className="w-full justify-start" onClick={() => { onOpenSettings(); onCloseMobile(); }} size="sm" variant="ghost">
          <Icon name="settings" size={15} />
          Settings
        </Button>
        <button
          className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/[0.045]"
          onClick={() => { onOpenSettings(); onCloseMobile(); }}
          type="button"
        >
          <span className={`size-1.5 rounded-full ${connection.dot}`} />
          <span className={`truncate ${connection.tone}`}>{connection.label}</span>
        </button>
      </div>
    </div>
  );
}

export function ThreadSidebar(props: ThreadSidebarProps) {
  const { mobileOpen, onMobileOpenChange, ...contentProps } = props;
  const closeMobile = () => onMobileOpenChange(false);

  return (
    <>
      <aside aria-label="Threads" className="hidden h-full w-[248px] shrink-0 border-r border-white/[0.07] lg:flex">
        <SidebarContent {...contentProps} onCloseMobile={() => undefined} />
      </aside>
      <Sheet onOpenChange={onMobileOpenChange} open={mobileOpen}>
        <SheetContent className="w-[min(88vw,300px)] p-0 sm:max-w-[300px]" side="left">
          <SheetTitle className="sr-only">Threads</SheetTitle>
          <SheetDescription className="sr-only">Switch between Helm conversations.</SheetDescription>
          <SidebarContent {...contentProps} onCloseMobile={closeMobile} />
        </SheetContent>
      </Sheet>
    </>
  );
}
