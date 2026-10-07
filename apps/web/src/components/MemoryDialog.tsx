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

type MemoryFormValue = {
  content: string;
  kind: MemoryKind;
  importance: number;
  key?: string;
  sourceUrl?: string;
  durability: 'durable' | 'refreshable';
};

type MemoryDurabilitySelection = 'durable' | 'refreshable' | 'unset';

type MemoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  memories: Memory[];
  memoryQuery: string;
  memoryLoading: boolean;
  memoryActionId: string | null;
  onMemoryQueryChange: (value: string) => void;
  onSearchMemories: (query: string) => Promise<void>;
  onAddMemory: (input: MemoryFormValue) => Promise<boolean>;
  onUpdateMemory: (memoryId: string, input: {
    content: string;
    kind: MemoryKind;
    importance: number;
    key: string | null;
    sourceUrl: string | null;
    durability: 'durable' | 'refreshable' | null;
  }) => Promise<boolean>;
  onDeleteMemory: (memoryId: string) => Promise<void>;
};

function sourceLabel(memory: Memory): string {
  switch (memory.source) {
    case 'observed': return 'Observed';
    case 'user': return 'From user';
    case 'passive-extraction': return 'Learned after turn';
    case 'manual': return 'Manual';
    default: return 'Legacy';
  }
}

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
  onUpdateMemory,
  onDeleteMemory,
}: MemoryDialogProps) {
  const [isAdding, setIsAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [kind, setKind] = useState<MemoryKind>('note');
  const [importance, setImportance] = useState(0.5);
  const [key, setKey] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [durability, setDurability] = useState<MemoryDurabilitySelection>('durable');

  function clearEditor() {
    setContent('');
    setKind('note');
    setImportance(0.5);
    setKey('');
    setSourceUrl('');
    setDurability('durable');
    setEditingId(null);
    setIsAdding(false);
  }

  function editMemory(memory: Memory) {
    setEditingId(memory.id);
    setIsAdding(false);
    setContent(memory.content);
    setKind(memory.kind);
    setImportance(memory.importance);
    setKey(memory.key ?? '');
    setSourceUrl(memory.sourceUrl ?? '');
    setDurability(memory.durability ?? 'unset');
  }

  async function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await onSearchMemories(memoryQuery.trim());
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!content.trim()) return;
    const common = {
      content: content.trim(),
      kind,
      importance,
    };
    const saved = editingId
      ? await onUpdateMemory(editingId, {
        ...common,
        key: key.trim() || null,
        sourceUrl: sourceUrl.trim() || null,
        durability: durability === 'unset' ? null : durability,
      })
      : await onAddMemory({
        ...common,
        durability: durability === 'refreshable' ? 'refreshable' : 'durable',
        ...(key.trim() ? { key: key.trim() } : {}),
        ...(sourceUrl.trim() ? { sourceUrl: sourceUrl.trim() } : {}),
      });
    if (saved) clearEditor();
  }

  const editorOpen = isAdding || editingId !== null;

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent className="w-[min(100vw,400px)] p-0 sm:max-w-[400px]" side="right">
        <SheetHeader className="border-b border-[var(--border)] pr-12">
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
            <Button className="w-full justify-start" onClick={() => {
              if (editorOpen) clearEditor();
              else setIsAdding(true);
            }} size="sm" variant="ghost">
              <Icon name={editorOpen ? 'x' : 'plus'} size={15} />
              {editingId ? 'Cancel editing' : editorOpen ? 'Cancel adding memory' : 'Add memory'}
            </Button>
            {editorOpen ? (
              <form className="space-y-3 rounded-lg bg-white/[0.035] p-3" onSubmit={(event) => void handleSave(event)}>
                <p className="text-xs font-medium text-[#aeb7c1]">{editingId ? 'Edit memory' : 'New memory'}</p>
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
                <label className="block space-y-1.5 text-xs text-[#79838f]">
                  <span>Stable key <span className="text-[#606975]">(optional)</span></span>
                  <Input onChange={(event) => setKey(event.target.value)} placeholder="preference:browser" value={key} />
                </label>
                <label className="block space-y-1.5 text-xs text-[#79838f]">
                  <span>Source URL <span className="text-[#606975]">(optional)</span></span>
                  <Input onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://…" type="url" value={sourceUrl} />
                </label>
                <label className="block space-y-1.5 text-xs text-[#79838f]">
                  <span>Lifetime</span>
                  <select className="h-9 w-full rounded-md border border-white/[0.1] bg-[#11151b] px-2.5 text-sm text-[#d7dde3] outline-none focus:border-teal-400/60" onChange={(event) => setDurability(event.target.value as MemoryDurabilitySelection)} value={durability}>
                    {editingId ? <option value="unset">Not set</option> : null}
                    <option value="durable">Durable</option>
                    <option value="refreshable">Refreshable</option>
                  </select>
                </label>
                <Button disabled={!content.trim() || memoryActionId === (editingId ?? 'new')} size="sm" type="submit">
                  <Icon name={editingId ? 'check' : 'plus'} size={14} /> {editingId ? 'Save changes' : 'Save memory'}
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
                      {memory.key ? <p className="mt-1 break-all font-mono text-[10px] text-[#79838f]">{memory.key}</p> : null}
                      {memory.sourceUrl ? <a className="mt-1 block break-all text-[11px] text-teal-300 hover:underline" href={memory.sourceUrl} rel="noreferrer" target="_blank">{memory.sourceUrl}</a> : null}
                      {memory.evidenceIds && memory.evidenceIds.length > 0 ? (
                        <p className="mt-1 break-all font-mono text-[10px] text-[#606975]" title={memory.evidenceIds.join(', ')}>
                          Receipts: {memory.evidenceIds.slice(0, 4).join(', ')}{memory.evidenceIds.length > 4 ? `, +${memory.evidenceIds.length - 4}` : ''}
                        </p>
                      ) : null}
                      <p className="mt-2 text-[11px] text-[#606975]">
                        {memory.kind} · {Math.round(memory.importance * 100)}% importance · {memory.durability ?? 'lifetime unset'} · {sourceLabel(memory)}
                      </p>
                      {memory.lastVerifiedAt ? <p className="mt-1 text-[10px] text-[#606975]">Verified {formatDate(memory.lastVerifiedAt)}</p> : null}
                      <p className="mt-1 text-[10px] text-[#606975]">Updated {formatDate(memory.updatedAt || memory.createdAt)}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      <Button aria-label={`Edit memory: ${memory.content.slice(0, 20)}`} className="invisible text-[#606975] opacity-0 group-hover:visible group-hover:opacity-100 focus-visible:visible focus-visible:opacity-100" disabled={memoryActionId === memory.id} onClick={() => editMemory(memory)} size="icon-sm" variant="ghost">
                        <Icon name="edit" size={13} />
                      </Button>
                      <Button aria-label={`Delete memory: ${memory.content.slice(0, 20)}`} className="invisible text-[#606975] opacity-0 group-hover:visible group-hover:opacity-100 hover:bg-red-500/10 hover:text-red-300 focus-visible:visible focus-visible:opacity-100" disabled={memoryActionId === memory.id} onClick={() => void onDeleteMemory(memory.id)} size="icon-sm" variant="ghost">
                        <Icon name="trash" size={13} />
                      </Button>
                    </div>
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
