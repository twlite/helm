import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { AgentChatPanel } from './agent-chat-panel';
import { ChatHistoryPanel } from './chat-history-panel';
import { DashboardHeader } from './dashboard-header';
import { DesktopVncPanel } from './desktop-vnc-panel';
import {
  deriveAgentCursor,
  deriveScreenshotFlashKey,
} from './event-derived-state';
import { useThemeMode } from './use-theme-mode';
import type { UseDesktopAgentResult } from './use-desktop-agent';
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from '@/components/ui/resizable';

type PanelView = 'history' | 'chat';
type PanelDirection = 'horizontal' | 'vertical';

const resolveDirection = (): PanelDirection => {
  if (typeof window === 'undefined') return 'horizontal';
  return window.matchMedia('(min-width: 1024px)').matches
    ? 'horizontal'
    : 'vertical';
};

interface DashboardLayoutProps {
  agent: UseDesktopAgentResult;
}

export function DashboardLayout({ agent }: DashboardLayoutProps) {
  const [panelDirection, setPanelDirection] =
    useState<PanelDirection>(resolveDirection);
  const [panelView, setPanelView] = useState<PanelView>('history');
  const { themeMode, toggleThemeMode } = useThemeMode();
  const navigate = useNavigate();

  const {
    activeConversationId,
    activeTitle,
    agentStatus,
    conversations,
    createAndOpenConversation,
    deletingConversationId,
    dequeueMessage,
    enqueueMessage,
    error,
    handleCancelRun,
    handleDeleteConversation,
    handleStartRun,
    hasMoreMessages,
    isBusy,
    isCancelling,
    liveEvents,
    liveRunId,
    liveRunStatus,
    loadOlderMessages,
    loading,
    loadingOlderMessages,
    messageQueue,
    messages,
    openConversation,
    reorderQueue,
    steerWithMessage,
    streamError,
    streamState,
    timeline,
    vncUrl,
  } = agent;

  // Switch to chat view once we have an active conversation
  useEffect(() => {
    if (activeConversationId && !loading) {
      // eslint-disable-next-line
      setPanelView('chat');
    }
  }, [activeConversationId, loading]);

  // If conversation is deleted/cleared, go back to history
  useEffect(() => {
    if (!activeConversationId) {
      // eslint-disable-next-line
      setPanelView('history');
    }
  }, [activeConversationId]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const media = window.matchMedia('(min-width: 1024px)');
    const apply = () =>
      setPanelDirection(media.matches ? 'horizontal' : 'vertical');
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, []);

  const handleOpenConversation = async (
    conversationId: string,
  ): Promise<boolean> => {
    const opened = await openConversation(conversationId);
    if (opened) setPanelView('chat');
    return opened;
  };

  const handleCreateConversation = async (): Promise<boolean> => {
    const created = await createAndOpenConversation();
    if (created) setPanelView('chat');
    return created;
  };

  const handleDeleteConversationFromList = async (
    conversationId: string,
  ): Promise<void> => {
    await handleDeleteConversation(conversationId);
    if (activeConversationId === conversationId) setPanelView('history');
  };

  const isAgentActive = agentStatus !== 'idle';
  const agentCursor = useMemo(
    () => deriveAgentCursor(liveEvents),
    [liveEvents],
  );
  const screenshotFlashKey = useMemo(
    () => deriveScreenshotFlashKey(liveEvents),
    [liveEvents],
  );

  return (
    <div className="min-h-dvh bg-[radial-gradient(circle_at_top,color-mix(in_oklch,var(--background),var(--foreground)_7%)_0%,var(--background)_52%)] text-foreground">
      <main className="mx-auto flex h-dvh w-full max-w-450 flex-col gap-4 p-4 lg:p-5">
        <DashboardHeader
          activeTitle={activeTitle}
          agentStatus={agentStatus}
          conversationStatus={timeline?.conversation.status ?? null}
          isBusy={isBusy}
          onNavigateToMemories={() => navigate('/memories')}
          onToggleThemeMode={toggleThemeMode}
          themeMode={themeMode}
        />
        <ResizablePanelGroup
          autoSaveId="desktop-main-layout"
          className="min-h-0 flex-1"
          direction={panelDirection}
        >
          <ResizablePanel defaultSize={24} minSize={20}>
            <div className="h-full min-h-0 pr-2">
              {panelView === 'chat' && activeConversationId ? (
                <AgentChatPanel
                  activeConversationId={activeConversationId}
                  agentStatus={agentStatus}
                  error={error}
                  hasMoreMessages={hasMoreMessages}
                  isBusy={isBusy}
                  isCancelling={isCancelling}
                  key={activeConversationId}
                  liveEvents={liveEvents}
                  liveRunId={liveRunId}
                  liveRunStatus={liveRunStatus}
                  loading={loading}
                  loadingOlderMessages={loadingOlderMessages}
                  messageQueue={messageQueue}
                  messages={messages}
                  onCancelRun={handleCancelRun}
                  onDequeueMessage={dequeueMessage}
                  onEnqueueMessage={enqueueMessage}
                  onLoadOlderMessages={loadOlderMessages}
                  onReorderQueue={reorderQueue}
                  onStartRun={handleStartRun}
                  onSteerWithMessage={steerWithMessage}
                  onViewChats={() => setPanelView('history')}
                  streamError={streamError}
                  streamState={streamState}
                  timeline={timeline}
                />
              ) : (
                <ChatHistoryPanel
                  activeConversationId={activeConversationId}
                  agentStatus={agentStatus}
                  conversations={conversations}
                  deletingConversationId={deletingConversationId}
                  isBusy={isBusy}
                  onCreateConversation={handleCreateConversation}
                  onDeleteConversation={handleDeleteConversationFromList}
                  onOpenConversation={handleOpenConversation}
                />
              )}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle={true} />
          <ResizablePanel defaultSize={58} minSize={30}>
            <div className="h-full min-h-0 pl-2">
              <DesktopVncPanel
                agentCursor={agentCursor}
                isActive={isAgentActive}
                screenshotFlashKey={screenshotFlashKey}
                vncUrl={vncUrl}
              />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </div>
  );
}
