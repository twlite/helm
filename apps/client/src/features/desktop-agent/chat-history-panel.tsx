import type { ConversationRecord } from '@/lib/api';
import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { buildConversationTitle, formatStatus } from './utils';

interface ChatHistoryPanelProps {
  conversations: ConversationRecord[];
  activeConversationId: string | null;
  deletingConversationId: string | null;
  onCreateConversation: () => Promise<boolean>;
  onDeleteConversation: (conversationId: string) => Promise<void>;
  onOpenConversation: (conversationId: string) => Promise<boolean>;
}

interface ContextMenuState {
  conversationId: string;
  x: number;
  y: number;
}

export function ChatHistoryPanel({
  conversations,
  activeConversationId,
  deletingConversationId,
  onCreateConversation,
  onDeleteConversation,
  onOpenConversation,
}: ChatHistoryPanelProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  useEffect(() => {
    const close = () => setContextMenu(null);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setContextMenu(null);
      }
    };

    window.addEventListener('click', close);
    window.addEventListener('resize', close);
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);

  const handleDeleteClick = async (conversationId: string) => {
    const target = conversations.find(
      (conversation) => conversation.id === conversationId,
    );

    if (!target) {
      return;
    }

    const confirmed = window.confirm(
      `Delete "${buildConversationTitle(target)}"? This cannot be undone.`,
    );

    if (!confirmed) {
      return;
    }

    setContextMenu(null);
    await onDeleteConversation(conversationId);
  };

  return (
    <Card className="h-full min-h-0 overflow-hidden border-border/70 bg-card/80" size="sm">
      <CardHeader className="border-b border-border/70 pb-3">
        <CardTitle className="text-base">Chats</CardTitle>
        <CardDescription>
          Choose a conversation or start a new desktop automation task.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex h-full min-h-0 flex-col gap-2 pt-3">
        <Button
          className="w-full"
          onClick={() => {
            void onCreateConversation();
          }}
          size="sm"
          variant="outline"
        >
          <PlusIcon className="size-4" />
          New Chat
        </Button>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 pr-2">
            {conversations.map((conversation) => {
              const isActive = conversation.id === activeConversationId;

              return (
                <button
                  className={cn(
                    'rounded-xl border px-3 py-2 text-left transition-colors',
                    isActive
                      ? 'border-primary/40 bg-primary/10'
                      : 'border-border/60 bg-background/60 hover:bg-muted',
                  )}
                  key={conversation.id}
                  onClick={() => {
                    void onOpenConversation(conversation.id);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();

                    const menuWidth = 208;
                    const menuHeight = 52;
                    const x = Math.min(
                      event.clientX,
                      window.innerWidth - menuWidth - 8,
                    );
                    const y = Math.min(
                      event.clientY,
                      window.innerHeight - menuHeight - 8,
                    );

                    setContextMenu({
                      conversationId: conversation.id,
                      x,
                      y,
                    });
                  }}
                  type="button"
                >
                  <div className="truncate font-medium text-sm">
                    {buildConversationTitle(conversation)}
                  </div>
                  <div className="mt-1 flex items-center justify-between text-muted-foreground text-xs">
                    <span className="truncate">
                      {deletingConversationId === conversation.id
                        ? 'Deleting chat...'
                        : (conversation.lastPreview ?? 'No messages yet')}
                    </span>
                    <span>{formatStatus(conversation.status)}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </ScrollArea>

        {contextMenu ? (
          <div
            className="fixed z-50"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <Card className="w-52 border-border/80 shadow-xl" size="sm">
              <CardContent className="p-1">
                <button
                  className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-destructive text-sm transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={
                    deletingConversationId === contextMenu.conversationId
                  }
                  onClick={() => {
                    void handleDeleteClick(contextMenu.conversationId);
                  }}
                  type="button"
                >
                  <Trash2Icon className="size-4" />
                  Delete Chat
                </button>
              </CardContent>
            </Card>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
