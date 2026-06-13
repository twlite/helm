import type { ConversationRecord } from "@/lib/api";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { BotIcon, DatabaseIcon, MessageSquareIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { AgentStatus } from "./types";
import { buildConversationTitle } from "./utils";

const STATUS_DOT: Record<string, string> = {
  idle:      "bg-muted-foreground/40",
  running:   "bg-blue-500 animate-pulse",
  completed: "bg-emerald-500",
  failed:    "bg-destructive",
  cancelled: "bg-muted-foreground/40",
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
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

interface ContextMenuState { conversationId: string; x: number; y: number; }

interface ChatHistoryPanelProps {
  conversations: ConversationRecord[];
  activeConversationId: string | null;
  agentStatus: AgentStatus;
  deletingConversationId: string | null;
  isBusy: boolean;
  onCreateConversation: () => Promise<boolean>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
  onOpenConversation: (conversationId: string) => Promise<boolean>;
}

export function ChatHistoryPanel({
  conversations,
  activeConversationId,
  agentStatus,
  deletingConversationId,
  isBusy,
  onCreateConversation,
  onDeleteConversation,
  onOpenConversation,
}: ChatHistoryPanelProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setContextMenu(null); };
    window.addEventListener("click", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("click", close); window.removeEventListener("resize", close); window.removeEventListener("keydown", onKey); };
  }, []);

  const handleCreate = async () => {
    setCreating(true);
    try { await onCreateConversation(); } finally { setCreating(false); }
  };

  const handleDeleteClick = async (conversationId: string) => {
    const target = conversations.find((c) => c.id === conversationId);
    if (!target) return;
    const title = buildConversationTitle(target);
    if (!window.confirm(`Delete "${title}"? This cannot be undone.`)) return;
    setContextMenu(null);
    await onDeleteConversation(conversationId);
  };

  return (
    <Card className="h-full min-h-0 overflow-hidden border-border/70 bg-card/80" size="sm">
      <CardHeader className="border-b border-border/70 pb-3">
        <CardTitle className="flex items-center justify-between text-sm">
          <div className="flex items-center gap-1.5">
            <BotIcon className="size-4 text-muted-foreground" />
            <span>Helm</span>
          </div>
          <Link
            className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-background/60 px-2 py-1 text-muted-foreground text-xs transition-colors hover:bg-muted hover:text-foreground"
            to="/memories"
          >
            <DatabaseIcon className="size-3" />
            Memory
          </Link>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex h-full min-h-0 flex-col gap-2 pt-3">
        <Button
          className="w-full"
          disabled={creating}
          onClick={() => { void handleCreate(); }}
          size="sm"
          variant="default"
        >
          {creating ? <Spinner className="size-3.5" /> : <PlusIcon className="size-4" />}
          New chat
        </Button>
        <ScrollArea className="min-h-0 flex-1">
          {conversations.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center text-muted-foreground text-sm">
              <MessageSquareIcon className="size-8 opacity-30" />
              <p>No chats yet</p>
            </div>
          ) : (
            <div className="flex flex-col gap-1 pr-2">
              {conversations.map((conversation) => {
                const isActive = conversation.id === activeConversationId;
                const isDeleting = deletingConversationId === conversation.id;
                const dotClass = isActive && isBusy ? STATUS_DOT.running : (STATUS_DOT[conversation.status] ?? STATUS_DOT.idle);
                return (
                  <button
                    className={cn(
                      "group relative rounded-xl border px-3 py-2.5 text-left transition-all",
                      isActive ? "border-primary/40 bg-primary/8 shadow-sm" : "border-transparent bg-transparent hover:border-border/50 hover:bg-muted/60",
                      isDeleting && "opacity-50 pointer-events-none",
                    )}
                    key={conversation.id}
                    onClick={() => { void onOpenConversation(conversation.id); }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setContextMenu({ conversationId: conversation.id, x: Math.min(e.clientX, window.innerWidth - 216), y: Math.min(e.clientY, window.innerHeight - 60) });
                    }}
                    type="button"
                  >
                    <div className="flex items-start gap-2">
                      <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", dotClass)} />
                      <div className="min-w-0 flex-1">
                        <p className={cn("truncate text-sm font-medium leading-tight", isActive ? "text-foreground" : "text-foreground/80")}>
                          {buildConversationTitle(conversation)}
                        </p>
                        <div className="mt-0.5 flex items-center justify-between gap-1">
                          <p className="truncate text-muted-foreground text-xs">
                            {isDeleting ? "Deleting…" : (conversation.lastPreview ?? "No messages yet")}
                          </p>
                          <span className="shrink-0 text-muted-foreground/60 text-xs">{formatRelativeTime(conversation.updatedAt)}</span>
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>
        {contextMenu ? (
          <div className="fixed z-50" onClick={(e) => e.stopPropagation()} style={{ left: contextMenu.x, top: contextMenu.y }}>
            <Card className="w-52 border-border/80 shadow-xl" size="sm">
              <CardContent className="p-1">
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-destructive text-sm transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={deletingConversationId === contextMenu.conversationId}
                  onClick={() => { void handleDeleteClick(contextMenu.conversationId); }}
                  type="button"
                >
                  <Trash2Icon className="size-4" />
                  Delete chat
                </button>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
