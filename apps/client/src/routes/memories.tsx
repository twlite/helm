import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { deleteMemory, getMemoryText, listMemories, type MemoryRecord } from "@/lib/api";
import { ArrowLeftIcon, ChevronDownIcon, ChevronRightIcon, DatabaseIcon, Trash2Icon } from "lucide-react";
import { useThemeMode } from "@/features/desktop-agent/use-theme-mode";
import { cn } from "@/lib/utils";
import { MoonIcon, SunIcon } from "lucide-react";

const ENTITY_TYPE_COLORS: Record<string, string> = {
  run_user_input:      "border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400",
  run_assistant_output:"border-violet-500/30 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  summary:             "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  episode:             "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
};

const formatRelativeTime = (iso: string): string => {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
};

const COLLECTION_LABELS: Record<string, string> = {
  helm_memory:   "Semantic memory",
  helm_episodes: "Episode log",
  helm_summaries:"Summary",
};

interface MemoryRowProps {
  memory: MemoryRecord;
  deletingId: string | null;
  onDelete: (id: string) => Promise<void>;
}

function MemoryRow({ memory, deletingId, onDelete }: MemoryRowProps) {
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [loadingText, setLoadingText] = useState(false);

  const handleToggle = async () => {
    if (!expanded && text === null) {
      setLoadingText(true);
      try {
        const fetched = await getMemoryText(memory.id);
        setText(fetched);
      } catch {
        setText("(failed to load)");
      } finally {
        setLoadingText(false);
      }
    }
    setExpanded((prev) => !prev);
  };

  const badgeClass = ENTITY_TYPE_COLORS[memory.entityType] ?? "border-border/60 bg-muted/30 text-muted-foreground";

  return (
    <div className="border-b border-border/40 last:border-0">
      <div className="flex items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-muted/20">
        <button
          className="flex min-w-0 flex-1 items-start gap-2 text-left"
          onClick={() => { void handleToggle(); }}
          type="button"
        >
          <span className="mt-0.5 shrink-0 text-muted-foreground/60">
            {loadingText ? (
              <Spinner className="size-3.5" />
            ) : expanded ? (
              <ChevronDownIcon className="size-3.5" />
            ) : (
              <ChevronRightIcon className="size-3.5" />
            )}
          </span>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", badgeClass)}>
                {memory.entityType.replace(/_/g, " ")}
              </span>
              <span className="text-muted-foreground/60 text-xs">
                {COLLECTION_LABELS[memory.chromaCollection] ?? memory.chromaCollection}
              </span>
            </div>
            <p className="truncate font-mono text-muted-foreground text-xs" title={memory.entityId}>
              {memory.entityId.slice(0, 12)}…
            </p>
            <p className="text-muted-foreground/50 text-xs">{formatRelativeTime(memory.createdAt)}</p>
          </div>
        </button>
        <Button
          className="shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={deletingId === memory.id}
          onClick={() => { void onDelete(memory.id); }}
          size="icon-sm"
          title="Delete this memory"
          variant="ghost"
        >
          {deletingId === memory.id ? <Spinner className="size-3.5" /> : <Trash2Icon className="size-3.5" />}
        </Button>
      </div>

      {expanded ? (
        <div className="border-t border-border/30 bg-muted/10 px-4 py-3">
          {text === null ? (
            <p className="text-muted-foreground text-xs italic">No content available.</p>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground/80">{text}</pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function MemoriesRoute() {
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | null>(null);
  const { themeMode, toggleThemeMode } = useThemeMode();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await listMemories();
      setMemories(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memories");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleDelete = async (id: string) => {
    if (!window.confirm("Delete this memory entry? This cannot be undone.")) return;
    setDeletingId(id);
    try {
      await deleteMemory(id);
      setMemories((prev) => prev.filter((m) => m.id !== id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete memory");
    } finally {
      setDeletingId(null);
    }
  };

  const collections = [...new Set(memories.map((m) => m.chromaCollection))];
  const filtered = filter ? memories.filter((m) => m.chromaCollection === filter) : memories;

  return (
    <div className="min-h-dvh bg-[radial-gradient(circle_at_top,color-mix(in_oklch,var(--background),var(--foreground)_7%)_0%,var(--background)_52%)] text-foreground">
      <div className="mx-auto max-w-2xl px-4 py-6 lg:px-6 lg:py-8">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Link
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-card/70 px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              to="/"
            >
              <ArrowLeftIcon className="size-4" />
              Back
            </Link>
            <div className="flex items-center gap-2">
              <DatabaseIcon className="size-5 text-muted-foreground" />
              <h1 className="text-xl font-semibold">Agent Memory</h1>
            </div>
          </div>
          <Button onClick={toggleThemeMode} size="sm" variant="outline">
            {themeMode === "dark" ? <SunIcon className="size-4" /> : <MoonIcon className="size-4" />}
          </Button>
        </div>

        <Card className="border-border/70 bg-card/80">
          <CardHeader className="border-b border-border/70 pb-4">
            <CardTitle className="text-base">Stored memories</CardTitle>
            <CardDescription>
              Click any entry to expand and read its content. These are used to recall past context across runs.
            </CardDescription>
            {memories.length > 0 ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors", filter === null ? "border-primary/40 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:bg-muted")}
                  onClick={() => setFilter(null)}
                  type="button"
                >
                  All ({memories.length})
                </button>
                {collections.map((col) => (
                  <button
                    className={cn("rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors", filter === col ? "border-primary/40 bg-primary/10 text-primary" : "border-border/60 text-muted-foreground hover:bg-muted")}
                    key={col}
                    onClick={() => setFilter(col === filter ? null : col)}
                    type="button"
                  >
                    {COLLECTION_LABELS[col] ?? col} ({memories.filter((m) => m.chromaCollection === col).length})
                  </button>
                ))}
              </div>
            ) : null}
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
                <Spinner />
                Loading memories…
              </div>
            ) : error ? (
              <div className="py-8 text-center text-destructive text-sm">{error}</div>
            ) : filtered.length === 0 ? (
              <div className="py-12 text-center text-muted-foreground text-sm">
                {memories.length === 0 ? "No memories stored yet. Run a few tasks first." : "No entries in this collection."}
              </div>
            ) : (
              <ScrollArea className="max-h-[65vh]">
                <div>
                  {filtered.map((memory) => (
                    <MemoryRow
                      deletingId={deletingId}
                      key={memory.id}
                      memory={memory}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        {!loading && memories.length > 0 ? (
          <p className="mt-3 text-center text-muted-foreground/60 text-xs">
            {memories.length} total entr{memories.length === 1 ? "y" : "ies"} across {collections.length} collection{collections.length === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
    </div>
  );
}
