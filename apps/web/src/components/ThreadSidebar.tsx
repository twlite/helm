import { useEffect, useState, type KeyboardEvent, type MouseEvent } from 'react';
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
  onCreateThread: () => void;
  onDeleteThread: (threadId: string) => Promise<void>;
  onRegenerateThreadTitle: (threadId: string) => Promise<void>;
  regeneratingTitleThreadId: string | null;
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

function visibleThreadTitle(title: string): string {
  const normalized = title.trim().replace(/\s+/gu, ' ');
  const maxLength = 30;
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

function ThreadRow({
  thread,
  selected,
  onSelect,
  onContextMenu,
}: {
  thread: Thread;
  selected: boolean;
  onSelect: () => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
    }
  }

  return (
    <div
      aria-current={selected ? 'page' : undefined}
      aria-haspopup="menu"
      className={`group box-border flex h-7 w-full min-w-0 max-w-full cursor-pointer items-center gap-2 overflow-hidden rounded-[4px] px-2 text-left transition-colors duration-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)] ${selected ? 'bg-[var(--selected-bg)] text-[var(--text)]' : 'text-[var(--text-secondary)] hover:bg-[var(--hover-bg)] hover:text-[var(--text)]'}`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onKeyDown={handleKeyDown}
      role="button"
      tabIndex={0}
    >
      <Icon className="shrink-0 text-[var(--text-muted)]" name="message" size={13} />
      <span className="min-w-0 flex-1 truncate text-xs" title={thread.title}>{visibleThreadTitle(thread.title)}</span>
      <span className="shrink-0 text-[10px] tabular-nums text-[var(--text-muted)]">{isToday(thread.updatedAt) ? formatTime(thread.updatedAt) : formatDate(thread.updatedAt)}</span>
    </div>
  );
}

function ThreadGroup({
  label,
  threads,
  selectedThreadId,
  onSelectThread,
  onContextMenu,
  onCloseMobile,
}: {
  label: string;
  threads: Thread[];
  selectedThreadId: string | null;
  onSelectThread: (threadId: string) => void;
  onContextMenu: (thread: Thread, event: MouseEvent<HTMLDivElement>) => void;
  onCloseMobile: () => void;
}) {
  if (threads.length === 0) {
    return null;
  }
  return (
    <section className="min-w-0 space-y-1">
      <h2 className="px-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">{label}</h2>
      <div>
        {threads.map((thread) => (
          <ThreadRow
            key={thread.id}
            onContextMenu={(event) => onContextMenu(thread, event)}
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
  onRegenerateThreadTitle,
  regeneratingTitleThreadId,
  connectionState,
  reconnectAttempt,
  onCloseMobile,
  onOpenMemory,
  onOpenSettings,
}: SidebarContentProps) {
  const [contextMenu, setContextMenu] = useState<{ thread: Thread; x: number; y: number } | null>(null);
  const todayThreads = threads.filter((thread) => isToday(thread.updatedAt));
  const previousThreads = threads.filter((thread) => !isToday(thread.updatedAt));
  const connection = connectionCopy(connectionState, reconnectAttempt);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setContextMenu(null);
    };
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [contextMenu]);

  function openContextMenu(thread: Thread, event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    const menuWidth = 208;
    const menuHeight = 104;
    setContextMenu({
      thread,
      x: Math.min(event.clientX, Math.max(8, window.innerWidth - menuWidth - 8)),
      y: Math.min(event.clientY, Math.max(8, window.innerHeight - menuHeight - 8)),
    });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden bg-[var(--pane-bg)]">
      <div className="flex h-11 items-center gap-2 border-b border-[var(--border)] px-3">
        <div className="flex size-5 items-center justify-center rounded-[4px] bg-[var(--accent)] text-[10px] font-bold text-[#07110f]">H</div>
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-[var(--text)]">Helm</p>
        <span className={`size-1.5 rounded-full ${connection.dot}`} title={connection.label} />
      </div>

      <div className="px-2 py-2">
        <Button
          className="w-full justify-start font-normal"
          onClick={() => {
            onCreateThread();
            onCloseMobile();
          }}
          size="sm"
          variant="ghost"
        >
          <Icon name="plus" size={15} />
          New thread
        </Button>
      </div>

      <ScrollArea className="min-h-0 w-full min-w-0 flex-1 overflow-x-hidden">
        <div className="box-border min-w-0 max-w-full space-y-4 overflow-hidden px-2 pb-3 pt-2">
          <div className="flex items-center justify-between px-2">
            <h2 className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-muted)]">Threads</h2>
            {threads.length > 0 ? <span className="text-[10px] text-[var(--text-muted)]">{threads.length}</span> : null}
          </div>
          <ThreadGroup label="Today" onCloseMobile={onCloseMobile} onContextMenu={openContextMenu} onSelectThread={onSelectThread} selectedThreadId={selectedThreadId} threads={todayThreads} />
          <ThreadGroup label="Previous" onCloseMobile={onCloseMobile} onContextMenu={openContextMenu} onSelectThread={onSelectThread} selectedThreadId={selectedThreadId} threads={previousThreads} />
          {threads.length === 0 ? (
            <p className="px-2 text-xs leading-5 text-[var(--text-muted)]">Saved conversations appear here.</p>
          ) : null}
        </div>
      </ScrollArea>

      <div className="border-t border-[var(--border)] px-2 py-2">
        <Button className="w-full justify-start" onClick={() => { onOpenMemory(); onCloseMobile(); }} size="sm" variant="ghost">
          <Icon name="memory" size={15} />
          Memory
        </Button>
        <Button className="w-full justify-start" onClick={() => { onOpenSettings(); onCloseMobile(); }} size="sm" variant="ghost">
          <Icon name="settings" size={15} />
          Settings
        </Button>
        <button
          className="flex h-7 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[11px] transition-colors hover:bg-[var(--hover-bg)]"
          onClick={() => { onOpenSettings(); onCloseMobile(); }}
          type="button"
        >
          <span className={`size-1.5 rounded-full ${connection.dot}`} />
          <span className="truncate text-[var(--text-muted)]">{connection.label}</span>
        </button>
      </div>
      {contextMenu ? (
        <>
          <button
            aria-label="Close thread menu"
            className="fixed inset-0 z-40 cursor-default"
            onClick={closeContextMenu}
            onContextMenu={(event) => {
              event.preventDefault();
              closeContextMenu();
            }}
            type="button"
          />
          <div
            className="fixed z-[60] min-w-52 overflow-hidden rounded-md border border-[var(--border-strong)] bg-[var(--pane-raised)] p-1 text-[var(--text)] shadow-xl shadow-black/30"
            onPointerDown={(event) => event.stopPropagation()}
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors hover:bg-white/[0.07] disabled:cursor-wait disabled:opacity-50"
              disabled={regeneratingTitleThreadId === contextMenu.thread.id}
              onClick={() => {
                closeContextMenu();
                void onRegenerateThreadTitle(contextMenu.thread.id);
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="refresh" size={14} />
              {regeneratingTitleThreadId === contextMenu.thread.id ? 'Regenerating title…' : 'Regenerate title'}
            </button>
            <div className="my-1 h-px bg-white/[0.08]" />
            <button
              className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-red-300 transition-colors hover:bg-red-500/10"
              onClick={() => {
                closeContextMenu();
                void onDeleteThread(contextMenu.thread.id);
              }}
              role="menuitem"
              type="button"
            >
              <Icon name="trash" size={14} />
              Delete thread
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function ThreadSidebar(props: ThreadSidebarProps) {
  const { mobileOpen, onMobileOpenChange, ...contentProps } = props;
  const closeMobile = () => onMobileOpenChange(false);

  return (
    <>
      <aside aria-label="Threads" className="hidden h-full w-[220px] min-w-0 shrink-0 overflow-hidden border-r border-[var(--border)] md:flex xl:w-[232px]">
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
