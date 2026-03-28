import { useEffect, useState } from 'react';
import { AgentChatPanel } from '@/features/desktop-agent/agent-chat-panel';
import { ChatHistoryPanel } from '@/features/desktop-agent/chat-history-panel';
import { DashboardHeader } from '@/features/desktop-agent/dashboard-header';
import { DesktopVncPanel } from '@/features/desktop-agent/desktop-vnc-panel';
import { useDesktopAgent } from '@/features/desktop-agent/use-desktop-agent';
import { useThemeMode } from '@/features/desktop-agent/use-theme-mode';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

type ChatViewMode = 'history' | 'conversation';
type PanelDirection = 'horizontal' | 'vertical';

const resolveDirection = (): PanelDirection => {
  if (typeof window === 'undefined') {
    return 'horizontal';
  }

  return window.matchMedia('(min-width: 1024px)').matches
    ? 'horizontal'
    : 'vertical';
};

export default function Index() {
  const [chatViewMode, setChatViewMode] = useState<ChatViewMode>('history');
  const [panelDirection, setPanelDirection] =
    useState<PanelDirection>(resolveDirection);
  const { themeMode, toggleThemeMode } = useThemeMode();
  const {
    activeConversationId,
    activeTitle,
    conversations,
    createAndOpenConversation,
    deletingConversationId,
    error,
    handleCancelRun,
    handleDeleteConversation,
    handleStartRun,
    hasMoreMessages,
    isBusy,
    isCancelling,
    liveAssistantText,
    liveReasoningMessages,
    liveRunId,
    liveRunStatus,
    liveToolCalls,
    liveToolResults,
    loadOlderMessages,
    loading,
    loadingOlderMessages,
    messages,
    openConversation,
    refreshActiveTimeline,
    streamError,
    streamState,
    timeline,
    vncUrl,
  } = useDesktopAgent();

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const media = window.matchMedia('(min-width: 1024px)');
    const applyDirection = () => {
      setPanelDirection(media.matches ? 'horizontal' : 'vertical');
    };

    applyDirection();
    media.addEventListener('change', applyDirection);

    return () => {
      media.removeEventListener('change', applyDirection);
    };
  }, []);

  useEffect(() => {
    if (!activeConversationId && chatViewMode === 'conversation') {
      // eslint-disable-next-line
      setChatViewMode('history');
    }
  }, [activeConversationId, chatViewMode]);

  const openConversationFromList = async (
    conversationId: string,
  ): Promise<boolean> => {
    const opened = await openConversation(conversationId);
    if (opened) {
      setChatViewMode('conversation');
    }

    return opened;
  };

  const createConversationFromList = async (): Promise<boolean> => {
    const created = await createAndOpenConversation();
    if (created) {
      setChatViewMode('conversation');
    }

    return created;
  };

  const deleteConversationFromList = async (conversationId: string) => {
    await handleDeleteConversation(conversationId);

    if (activeConversationId === conversationId) {
      setChatViewMode('history');
    }
  };

  return (
    <div className="min-h-dvh bg-[radial-gradient(circle_at_top,color-mix(in_oklch,var(--background),var(--foreground)_7%)_0%,var(--background)_52%)] text-foreground">
      <main className="mx-auto flex h-dvh w-full max-w-450 flex-col gap-4 p-4 lg:p-5">
        <DashboardHeader
          activeTitle={activeTitle}
          conversationStatus={timeline?.conversation.status ?? null}
          onRefresh={() => {
            void refreshActiveTimeline();
          }}
          onToggleThemeMode={toggleThemeMode}
          themeMode={themeMode}
        />

        <ResizablePanelGroup
          autoSaveId="desktop-main-layout"
          className="min-h-0 flex-1"
          direction={panelDirection}
        >
          <ResizablePanel defaultSize={24} minSize={24}>
            <div className="h-full min-h-0 pr-2">
              {chatViewMode === 'history' || !activeConversationId ? (
                <ChatHistoryPanel
                  activeConversationId={activeConversationId}
                  conversations={conversations}
                  deletingConversationId={deletingConversationId}
                  onCreateConversation={createConversationFromList}
                  onDeleteConversation={deleteConversationFromList}
                  onOpenConversation={openConversationFromList}
                />
              ) : (
                <AgentChatPanel
                  activeConversationId={activeConversationId}
                  error={error}
                  hasMoreMessages={hasMoreMessages}
                  isBusy={isBusy}
                  isCancelling={isCancelling}
                  key={activeConversationId ?? 'no-conversation'}
                  liveAssistantText={liveAssistantText}
                  liveReasoningMessages={liveReasoningMessages}
                  liveRunId={liveRunId}
                  liveRunStatus={liveRunStatus}
                  liveToolCalls={liveToolCalls}
                  liveToolResults={liveToolResults}
                  loading={loading}
                  loadingOlderMessages={loadingOlderMessages}
                  messages={messages}
                  onBackToChats={() => setChatViewMode('history')}
                  onCancelRun={handleCancelRun}
                  onLoadOlderMessages={loadOlderMessages}
                  onStartRun={handleStartRun}
                  streamError={streamError}
                  streamState={streamState}
                  timeline={timeline}
                />
              )}
            </div>
          </ResizablePanel>

          <ResizableHandle withHandle={true} />

          <ResizablePanel defaultSize={58} minSize={30}>
            <div className="h-full min-h-0 pl-2">
              <DesktopVncPanel vncUrl={vncUrl} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </div>
  );
}
