import { useState } from 'react';
import type { FormEvent } from 'react';
import type { Memory, MemoryKind } from '../types';
import { formatDate } from '../format';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ScrollArea } from './ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from './ui/sheet';
import { Textarea } from './ui/textarea';

type MemoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memories: Memory[];
  memoryQuery: string;
  memoryLoading: boolean;
  memoryActionId: string | null;
  onMemoryQueryChange: (value: string) => void;
  onSearchMemories: (query: string) => Promise<void>;
  onAddMemory: (input: { content: string; kind: MemoryKind; importance: number }) => Promise<boolean>;
  onDeleteMemory: (memoryId: string) => Promise<void>;
};

export function MemoryDialog({
  open,
  onOpenChange,
  memories,
  memoryQuery,
  memoryLoading,
  memoryActionId,
  onMemoryQueryChange,
  onSearchMemories,
  onAddMemory,
  onDeleteMemory,
}: MemoryDialogProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('note');
  const [importance, setImportance] = useState(0.5);

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSearchMemories(memoryQuery.trim());
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) {
      return;
    }
    const saved = await onAddMemory({ content: content.trim(), kind, importance });
    if (saved) {
      setContent('');
      setKind('note');
      setImportance(0.5);
      setIsAdding(false);
    }
  }

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-[min(100vw,400px)] p-0 sm:max-w-[400px]" side="right">
        <SheetHeader className="border-b border-white/[0.06] pr-14">
          <SheetTitle>Memory</SheetTitle>
          <SheetDescription>Durable context Helm can use across threads.</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="space-y-3 px-5 py-4">
            <form className="flex gap-2" onSubmit={(event) => void handleSearch(event)}>
              <div className="relative min-w-0 flex-1">
                <Icon className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#606975]" name="search" size={14} />
                <Input aria-label="Search memories" className="pl-8" onChange={(event) => onMemoryQueryChange(event.target.value)} placeholder="Search memories" value={memoryQuery} />
              </div>
              <Button aria-label="Search memories" disabled={memoryLoading} size="icon" type="submit" variant="secondary">
                {memoryLoading ? <Icon className="animate-spin" name="refresh" size={14} /> : <Icon name="arrow-up" size={14} />}
              </Button>
            </form>
            <Button className="w-full justify-start" onClick={() => setIsAdding((current) => !current)} size="sm" variant="ghost">
              <Icon name={isAdding ? 'x' : 'plus'} size={15} />
              {isAdding ? 'Cancel adding memory' : 'Add memory'}
            </Button>
            {isAdding ? (
              <form className="space-y-3 rounded-lg bg-white/[0.035] p-3" onSubmit={(event) => void handleAdd(event)}>
                <label className="sr-only" htmlFor="memory-content">Memory content</label>
                <Textarea id="memory-content" onChange={(event) => setContent(event.target.value)} placeholder="A durable fact or preference…" rows={4} value={content} />
                <div className="grid grid-cols-[1fr_100px] gap-2">
                  <label className="space-y-1.5 text-xs text-[#79838f]">
                    <span>Kind</span>
                    <select className="h-9 w-full rounded-md border border-white/[0.1] bg-[#11151b] px-2.5 text-sm text-[#d7dde3] outline-none focus:border-teal-400/60" onChange={(event) => setKind(event.target.value as MemoryKind)} value={kind}>
                      <option value="note">Note</option>
                      <option value="fact">Fact</option>
                      <option value="preference">Preference</option>
                      <option value="instruction">Instruction</option>
                    </select>
                  </label>
                  <label className="space-y-1.5 text-xs text-[#79838f]">
                    <span>Importance</span>
                    <Input max="1" min="0" onChange={(event) => setImportance(Number(event.target.value))} step="0.1" type="number" value={importance} />
                  </label>
                </div>
                <Button disabled={!content.trim() || memoryActionId === 'new'} size="sm" type="submit">
                  <Icon name="plus" size={14} /> Save memory
                </Button>
              </form>
            ) : null}
          </div>
          <ScrollArea className="min-h-0 flex-1 px-5">
            <div className="space-y-1 pb-8">
              {memoryLoading ? <p className="py-6 text-sm text-[#79838f]">Loading memory…</p> : memories.length > 0 ? memories.map((memory) => (
                <article className="group rounded-lg px-3 py-3 transition-colors hover:bg-white/[0.035]" key={memory.id}>
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md bg-teal-400/10 text-teal-300"><Icon name="memory" size={13} /></div>
                    <div className="min-w-0 flex-1">
                      <p className="whitespace-pre-wrap break-words text-sm leading-5 text-[#c9d1d9]">{memory.content}</p>
                      <p className="mt-2 text-[11px] text-[#606975]">{memory.kind} · {Math.round(memory.importance * 100)}% importance · {formatDate(memory.updatedAt || memory.createdAt)}</p>
                    </div>
                    <Button aria-label={`Delete memory: ${memory.content.slice(0, 20)}`} className="invisible text-[#606975] opacity-0 group-hover:visible group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-300 focus-visible:visible focus-visible:opacity-100" disabled={memoryActionId === memory.id} onClick={() => void onDeleteMemory(memory.id)} size="icon-sm" variant="ghost">
                      <Icon name="trash" size={13} />
                    </Button>
                  </div>
                </article>
              )) : <p className="py-6 text-sm text-[#79838f]">No memories match this view.</p>}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
