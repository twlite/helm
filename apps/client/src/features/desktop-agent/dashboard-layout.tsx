import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { AgentChatPanel } from "./agent-chat-panel";
import { ChatHistoryPanel } from "./chat-history-panel";
import { DashboardHeader } from "./dashboard-header";
import { DesktopVncPanel, type AgentCursorPosition } from "./desktop-vnc-panel";
import type { LiveEvent } from "./types";
import { useThemeMode } from "./use-theme-mode";
import type { UseDesktopAgentResult } from "./use-desktop-agent";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

type PanelView = "history" | "chat";
type PanelDirection = "horizontal" | "vertical";

const MOUSE_TOOL_NAMES = new Set([
  "capture_screenshot",
  "click_mouse",
  "double_click_mouse",
  "drag_mouse",
  "get_mouse_location",
  "move_mouse",
]);

const CLICK_TOOL_NAMES = new Set(["click_mouse", "double_click_mouse"]);

const resolveDirection = (): PanelDirection => {
  if (typeof window === "undefined") return "horizontal";
  return window.matchMedia("(min-width: 1024px)").matches ? "horizontal" : "vertical";
};

interface DashboardLayoutProps { agent: UseDesktopAgentResult; }

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

const getNumber = (record: Record<string, unknown> | null, key: string): number | null => {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const hasFractionalPart = (value: number): boolean => !Number.isInteger(value);

const resolveRawPoint = (
  point: { x: number; y: number },
  geometry: { width: number; height: number },
): { x: number; y: number } => {
  if (
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1 &&
    (hasFractionalPart(point.x) || hasFractionalPart(point.y))
  ) {
    return {
      x: point.x * Math.max(0, geometry.width - 1),
      y: point.y * Math.max(0, geometry.height - 1),
    };
  }

  const maxX = Math.max(0, geometry.width - 1);
  const maxY = Math.max(0, geometry.height - 1);
  if (
    point.x >= 0 &&
    point.x <= 1000 &&
    point.y >= 0 &&
    point.y <= 1000 &&
    (point.x > maxX || point.y > maxY)
  ) {
    return {
      x: (point.x / 1000) * maxX,
      y: (point.y / 1000) * maxY,
    };
  }

  return point;
};

const extractPoint = (
  output: Record<string, unknown>,
  geometry: { width: number; height: number },
): { x: number; y: number } | null => {
  const cursor = asRecord(output.cursor);
  const resolvedTarget = asRecord(output.resolvedTarget);
  const cursorAfter = asRecord(output.cursorAfter);
  const cursorAfterMove = asRecord(output.cursorAfterMove);
  const movedTo = asRecord(output.movedTo);

  const candidates = [
    { x: getNumber(cursorAfterMove, "x"), y: getNumber(cursorAfterMove, "y") },
    { x: getNumber(resolvedTarget, "x"), y: getNumber(resolvedTarget, "y") },
    { x: getNumber(movedTo, "x"), y: getNumber(movedTo, "y") },
    { x: getNumber(cursorAfter, "x"), y: getNumber(cursorAfter, "y") },
    { x: getNumber(cursor, "x"), y: getNumber(cursor, "y") },
    { x: getNumber(output, "x"), y: getNumber(output, "y"), needsResolution: true },
  ];

  const match = candidates.find((point) => point.x !== null && point.y !== null);
  if (!match) {
    return null;
  }

  const point = { x: match.x as number, y: match.y as number };
  return "needsResolution" in match ? resolveRawPoint(point, geometry) : point;
};

const extractGeometry = (
  output: Record<string, unknown>,
): { width: number; height: number } | null => {
  const geometry = asRecord(output.displayGeometry) ?? asRecord(output.geometry);
  const width = getNumber(geometry, "width");
  const height = getNumber(geometry, "height");

  return width && height && width > 0 && height > 0 ? { width, height } : null;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

const deriveAgentCursor = (liveEvents: LiveEvent[]): AgentCursorPosition | null => {
  for (let index = liveEvents.length - 1; index >= 0; index -= 1) {
    const event = liveEvents[index];
    if (
      (event?.type !== "tool_result" && event?.type !== "tool_call") ||
      !MOUSE_TOOL_NAMES.has(event.toolName)
    ) {
      continue;
    }

    const payload = event.type === "tool_result" ? event.output : event.input;
    const geometry = extractGeometry(payload) ?? { width: 1366, height: 768 };
    const point = extractPoint(payload, geometry);
    if (!point) {
      continue;
    }

    return {
      clickKey: CLICK_TOOL_NAMES.has(event.toolName)
        ? `${index}-${event.type}-${event.toolName}-click`
        : null,
      eventKey: `${index}-${event.type}-${event.toolName}`,
      height: geometry.height,
      isClicking: event.type === "tool_call" && CLICK_TOOL_NAMES.has(event.toolName),
      width: geometry.width,
      xPercent: clampPercent((point.x / geometry.width) * 100),
      yPercent: clampPercent((point.y / geometry.height) * 100),
    };
  }

  return null;
};

export function DashboardLayout({ agent }: DashboardLayoutProps) {
  const [panelDirection, setPanelDirection] = useState<PanelDirection>(resolveDirection);
  const [panelView, setPanelView] = useState<PanelView>("history");
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
      setPanelView("chat");
    }
  }, [activeConversationId, loading]);

  // If conversation is deleted/cleared, go back to history
  useEffect(() => {
    if (!activeConversationId) {
      setPanelView("history");
    }
  }, [activeConversationId]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(min-width: 1024px)");
    const apply = () => setPanelDirection(media.matches ? "horizontal" : "vertical");
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const handleOpenConversation = async (conversationId: string): Promise<boolean> => {
    const opened = await openConversation(conversationId);
    if (opened) setPanelView("chat");
    return opened;
  };

  const handleCreateConversation = async (): Promise<boolean> => {
    const created = await createAndOpenConversation();
    if (created) setPanelView("chat");
    return created;
  };

  const handleDeleteConversationFromList = async (conversationId: string): Promise<void> => {
    await handleDeleteConversation(conversationId);
    if (activeConversationId === conversationId) setPanelView("history");
  };

  const isAgentActive = agentStatus !== "idle";
  const agentCursor = useMemo(() => deriveAgentCursor(liveEvents), [liveEvents]);

  return (
    <div className="min-h-dvh bg-[radial-gradient(circle_at_top,color-mix(in_oklch,var(--background),var(--foreground)_7%)_0%,var(--background)_52%)] text-foreground">
      <main className="mx-auto flex h-dvh w-full max-w-450 flex-col gap-4 p-4 lg:p-5">
        <DashboardHeader
          activeTitle={activeTitle}
          agentStatus={agentStatus}
          conversationStatus={timeline?.conversation.status ?? null}
          isBusy={isBusy}
          onNavigateToMemories={() => navigate("/memories")}
          onToggleThemeMode={toggleThemeMode}
          themeMode={themeMode}
        />
        <ResizablePanelGroup autoSaveId="desktop-main-layout" className="min-h-0 flex-1" direction={panelDirection}>
          <ResizablePanel defaultSize={24} minSize={20}>
            <div className="h-full min-h-0 pr-2">
              {panelView === "chat" && activeConversationId ? (
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
                  onViewChats={() => setPanelView("history")}
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
              <DesktopVncPanel agentCursor={agentCursor} isActive={isAgentActive} vncUrl={vncUrl} />
            </div>
          </ResizablePanel>
        </ResizablePanelGroup>
      </main>
    </div>
  );
}
