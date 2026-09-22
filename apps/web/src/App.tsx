import { useCallback, useEffect, useRef, useState } from 'react';
import { helmApi, parseError } from './api';
import { ActivityDrawer } from './components/ActivityDrawer';
import { Conversation, type ConversationNotice } from './components/Conversation';
import { DesktopPanel } from './components/DesktopPanel';
import { MemoryDialog } from './components/MemoryDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ThreadSidebar } from './components/ThreadSidebar';
import { useHelmWebSocket } from './hooks/useHelmWebSocket';
import type {
  AsyncState,
  ConnectionState,
  HelmEvent,
  HealthStatus,
  Memory,
  MemoryKind,
  Message,
  RunDetails,
  Thread,
  VmAction,
  VmStatus,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function fallbackThreadTitle(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length <= 200) return trimmed;
  return `${trimmed.slice(0, 197).trimEnd()}...`;
}

function mergeVmStatus(payload: unknown, previous: VmStatus | null): VmStatus | null {
  const source = isRecord(payload) && isRecord(payload.vm) ? payload.vm : payload;
  if (!isRecord(source)) {
    return previous;
  }
  const rawState = source.state ?? source.status;
  const states: VmStatus['state'][] = ['stopped', 'starting', 'running', 'stopping', 'error', 'unavailable'];
  const state = states.includes(rawState as VmStatus['state'])
    ? (rawState as VmStatus['state'])
    : previous?.state ?? 'unavailable';
  return {
    state,
    helperAvailable: typeof source.helperAvailable === 'boolean' ? source.helperAvailable : previous?.helperAvailable ?? false,
    guestConnected: typeof source.guestConnected === 'boolean' ? source.guestConnected : previous?.guestConnected ?? false,
    message: asString(source.message) ?? previous?.message,
    screenshot: asString(source.screenshot) ?? previous?.screenshot,
  };
}

function extractScreenshot(payload: unknown): string | undefined {
  const candidate = typeof payload === 'string'
    ? payload
    : isRecord(payload)
      ? asString(payload.screenshot) ?? asString(payload.data) ?? asString(payload.image) ?? asString(payload.base64)
      : undefined;
  if (!candidate) {
    return undefined;
  }
  if (candidate.startsWith('data:') || candidate.startsWith('http://') || candidate.startsWith('https://') || candidate.startsWith('blob:')) {
    return candidate;
  }
  return `data:image/png;base64,${candidate}`;
}

function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [messageState, setMessageState] = useState<AsyncState>('idle');
  const [isRunStarting, setIsRunStarting] = useState(false);
  const [isRetryingRun, setIsRetryingRun] = useState(false);
  const [run, setRun] = useState<RunDetails | null>(null);
  const [vm, setVm] = useState<VmStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [vmAction, setVmAction] = useState<VmAction | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryActionId, setMemoryActionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ConversationNotice | null>(null);
  const [isActivityOpen, setIsActivityOpen] = useState(false);
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const selectedThreadIdRef = useRef<string | null>(null);
  const runRequestRef = useRef(0);
  selectedThreadIdRef.current = selectedThreadId;

  const selectedThread = threads.find((thread) => thread.id === selectedThreadId) ?? null;

  const showError = useCallback((error: unknown) => {
    setNotice({ tone: 'error', message: parseError(error) });
  }, []);

  const refreshRun = useCallback(async (runId: string) => {
    const requestId = runRequestRef.current + 1;
    runRequestRef.current = requestId;
    try {
      const nextRun = await helmApi.getRun(runId);
      if (requestId !== runRequestRef.current) {
        return;
      }
      const currentThreadId = selectedThreadIdRef.current;
      if (currentThreadId && nextRun.threadId && currentThreadId !== nextRun.threadId) {
        return;
      }
      setRun(nextRun);
    } catch (error) {
      if (requestId === runRequestRef.current) {
        showError(error);
      }
    }
  }, [showError]);

  const handleEvent = useCallback((event: HelmEvent) => {
    if (event.type === 'vm.status') {
      setVm((current) => mergeVmStatus(event.payload, current));
      setHealth((current) => {
        const nextVm = mergeVmStatus(event.payload, current?.vm ?? null);
        return current && nextVm ? { ...current, vm: nextVm } : current;
      });
    }
    if (event.type === 'guest.connected' || event.type === 'guest.disconnected') {
      setVm((current) => current ? { ...current, guestConnected: event.type === 'guest.connected' } : current);
      setHealth((current) => current ? { ...current, vm: { ...current.vm, guestConnected: event.type === 'guest.connected' } } : current);
    }
    if (event.type === 'desktop.screenshot') {
      const nextScreenshot = extractScreenshot(event.payload);
      if (nextScreenshot) {
        setScreenshot(nextScreenshot);
        setVm((current) => current ? { ...current, screenshot: nextScreenshot } : current);
      }
    }
    if (event.runId && event.type.startsWith('run.')) {
      setIsActivityOpen(true);
      void refreshRun(event.runId);
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
        const currentThreadId = selectedThreadIdRef.current;
        if (currentThreadId) {
          void helmApi.listMessages(currentThreadId).then(setMessages).catch(() => undefined);
        }
      }
    }
  }, [refreshRun]);

  const socket = useHelmWebSocket(handleEvent);

  useEffect(() => {
    let cancelled = false;
    async function loadInitialData() {
      const [threadResult, healthResult, vmResult, memoryResult] = await Promise.allSettled([
        helmApi.listThreads(),
        helmApi.health(),
        helmApi.vmStatus(),
        helmApi.listMemories(),
      ]);
      if (cancelled) {
        return;
      }
      let failed = 0;
      if (threadResult.status === 'fulfilled') {
        setThreads(threadResult.value);
        setSelectedThreadId((current) => current ?? threadResult.value[0]?.id ?? null);
      } else {
        failed += 1;
      }
      if (healthResult.status === 'fulfilled') {
        setHealth(healthResult.value);
        setVm(healthResult.value.vm);
        if (healthResult.value.vm.screenshot) {
          setScreenshot(healthResult.value.vm.screenshot);
        }
      } else {
        failed += 1;
      }
      if (vmResult.status === 'fulfilled') {
        setVm(vmResult.value);
        if (vmResult.value.screenshot) {
          setScreenshot(vmResult.value.screenshot);
        }
      } else {
        failed += 1;
      }
      if (memoryResult.status === 'fulfilled') {
        setMemories(memoryResult.value);
      } else {
        failed += 1;
      }
      if (failed === 4) {
        setNotice({ tone: 'error', message: 'Helm backend is not reachable. The UI will reconnect when it is available.' });
      }
    }
    void loadInitialData();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedThreadId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setMessageState('loading');
    void helmApi.listMessages(selectedThreadId)
      .then((nextMessages) => {
        if (!cancelled) {
          setMessages(nextMessages);
          setMessageState('idle');
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMessageState('error');
          showError(error);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [selectedThreadId, showError]);

  const handleSelectThread = useCallback((threadId: string) => {
    setSelectedThreadId(threadId);
    setRun(null);
    setIsActivityOpen(false);
    setDraft('');
    setNotice(null);
  }, []);

  const handleCreateThread = useCallback(() => {
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setMessages([]);
    setDraft('');
    setRun(null);
    setIsActivityOpen(false);
    setNotice(null);
    setMessageState('idle');
  }, []);

  const handleDeleteThread = useCallback(async (threadId: string) => {
    const thread = threads.find((item) => item.id === threadId);
    if (!thread || !window.confirm(`Delete “${thread.title}” and its messages?`)) {
      return;
    }
    try {
      await helmApi.deleteThread(threadId);
      const remaining = threads.filter((item) => item.id !== threadId);
      setThreads(remaining);
      if (selectedThreadIdRef.current === threadId) {
        setSelectedThreadId(remaining[0]?.id ?? null);
        setMessages([]);
        setRun(null);
        setIsActivityOpen(false);
      }
    } catch (error) {
      showError(error);
    }
  }, [showError, threads]);

  const handleSendMessage = useCallback(async (content: string) => {
    setMessageState('saving');
    setNotice(null);
    try {
      let threadId = selectedThreadIdRef.current;
      const shouldGenerateTitle = !threadId;
      if (!threadId) {
        const thread = await helmApi.createThread(fallbackThreadTitle(content));
        threadId = thread.id;
        selectedThreadIdRef.current = thread.id;
        setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
        setSelectedThreadId(thread.id);
        setMessages([]);
        setRun(null);
        setIsActivityOpen(false);
      }
      const message = await helmApi.createMessage(threadId, content);
      setMessages((current) => [...current, message]);
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, updatedAt: message.createdAt } : thread));
      setDraft('');
      setMessageState('idle');
      if (shouldGenerateTitle) {
        void helmApi.generateThreadTitle(threadId, message.id)
          .then((updatedThread) => {
            setThreads((current) => current.map((thread) => thread.id === updatedThread.id ? updatedThread : thread));
          })
          .catch(() => undefined);
      }
      try {
        const nextRun = await helmApi.runAgent(threadId, message.id);
        setRun(nextRun);
        setIsActivityOpen(true);
      } catch (error) {
        showError(error);
      }
    } catch (error) {
      setMessageState('error');
      showError(error);
    }
  }, [showError]);

  const handleRunDemo = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) {
      return;
    }
    setIsRunStarting(true);
    setIsActivityOpen(true);
    setNotice(null);
    try {
      const nextRun = await helmApi.runScriptedDemo(threadId);
      setRun(nextRun);
    } catch (error) {
      showError(error);
    } finally {
      setIsRunStarting(false);
    }
  }, [showError]);

  const handleCancelRun = useCallback(async (runId: string) => {
    try {
      await helmApi.cancelRun(runId);
      await refreshRun(runId);
    } catch (error) {
      showError(error);
    }
  }, [refreshRun, showError]);

  const handleRetryRun = useCallback(async (runId?: string) => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId || isRetryingRun) {
      return;
    }

    setIsRetryingRun(true);
    setNotice(null);
    try {
      const currentRun = run;
      let sourceMessageId = currentRun && currentRun.id === runId ? currentRun.sourceMessageId : undefined;
      if (!sourceMessageId && runId) {
        sourceMessageId = (await helmApi.getRun(runId)).sourceMessageId;
      }
      sourceMessageId ??= [...messages].reverse().find((message) => message.role === 'user')?.id;
      if (!sourceMessageId) {
        throw new Error('Helm could not find the message for this run.');
      }

      const nextRun = await helmApi.runAgent(threadId, sourceMessageId);
      setRun(nextRun);
      setIsActivityOpen(true);
    } catch (error) {
      showError(error);
    } finally {
      setIsRetryingRun(false);
    }
  }, [isRetryingRun, messages, run, showError]);

  const handleOpenActivity = useCallback(async (runId?: string) => {
    setIsActivityOpen(true);
    if (!runId || run?.id === runId) {
      return;
    }
    try {
      setRun(await helmApi.getRun(runId));
    } catch (error) {
      showError(error);
    }
  }, [run, showError]);

  const handleVmAction = useCallback(async (action: VmAction) => {
    setVmAction(action);
    setNotice(null);
    try {
      const nextVm = await helmApi.vmAction(action);
      setVm(nextVm);
      setHealth((current) => current ? { ...current, vm: nextVm } : current);
      if (nextVm.screenshot) {
        setScreenshot(nextVm.screenshot);
      }
    } catch (error) {
      showError(error);
    } finally {
      setVmAction(null);
    }
  }, [showError]);

  const handleRefreshDiagnostics = useCallback(async () => {
    const [healthResult, vmResult] = await Promise.allSettled([helmApi.health(), helmApi.vmStatus()]);
    if (healthResult.status === 'fulfilled') {
      setHealth(healthResult.value);
      setVm(healthResult.value.vm);
    }
    if (vmResult.status === 'fulfilled') {
      setVm(vmResult.value);
    }
    if (healthResult.status === 'rejected' && vmResult.status === 'rejected') {
      showError(healthResult.reason);
    }
  }, [showError]);

  const handleMemorySearch = useCallback(async (query: string) => {
    setMemoryLoading(true);
    try {
      setMemories(await helmApi.listMemories(query));
    } catch (error) {
      showError(error);
    } finally {
      setMemoryLoading(false);
    }
  }, [showError]);

  const handleAddMemory = useCallback(async (input: { content: string; kind: MemoryKind; importance: number }): Promise<boolean> => {
    setMemoryActionId('new');
    try {
      const memory = await helmApi.createMemory(input);
      setMemories((current) => [memory, ...current]);
      return true;
    } catch (error) {
      showError(error);
      return false;
    } finally {
      setMemoryActionId(null);
    }
  }, [showError]);

  const handleDeleteMemory = useCallback(async (memoryId: string) => {
    setMemoryActionId(memoryId);
    try {
      await helmApi.deleteMemory(memoryId);
      setMemories((current) => current.filter((memory) => memory.id !== memoryId));
    } catch (error) {
      showError(error);
    } finally {
      setMemoryActionId(null);
    }
  }, [showError]);

  const connectionState: ConnectionState = socket.state;

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-[#0b0d10] font-sans text-[#f1f3f5]">
      <ThreadSidebar
        connectionState={connectionState}
        onCreateThread={handleCreateThread}
        onDeleteThread={handleDeleteThread}
        onMobileOpenChange={setIsMobileSidebarOpen}
        onOpenMemory={() => {
          setIsActivityOpen(false);
          setIsMemoryOpen(true);
        }}
        onOpenSettings={() => {
          setIsActivityOpen(false);
          setIsSettingsOpen(true);
        }}
        onSelectThread={handleSelectThread}
        reconnectAttempt={socket.attempt}
        selectedThreadId={selectedThreadId}
        threads={threads}
        mobileOpen={isMobileSidebarOpen}
      />
      <section className="flex min-w-0 flex-1">
        <Conversation
          activityOpen={isActivityOpen}
          draft={draft}
          isLoading={messageState === 'loading'}
          isRunStarting={isRunStarting}
          isRetryingRun={isRetryingRun}
          isSending={messageState === 'saving'}
          messages={messages}
          onDraftChange={setDraft}
          onDismissNotice={() => setNotice(null)}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
          onOpenActivity={(runId) => void handleOpenActivity(runId)}
          onRunDemo={handleRunDemo}
          onRetryRun={handleRetryRun}
          onSend={handleSendMessage}
          onToggleActivity={() => setIsActivityOpen((current) => !current)}
          notice={notice}
          run={run}
          thread={selectedThread}
        />
        <DesktopPanel onVmAction={handleVmAction} screenshot={screenshot} vm={vm} vmAction={vmAction} />
      </section>
      <ActivityDrawer
        isRunStarting={isRunStarting}
        onCancelRun={handleCancelRun}
        onRetryRun={handleRetryRun}
        isRetryingRun={isRetryingRun}
        onOpenChange={setIsActivityOpen}
        onRunDemo={handleRunDemo}
        open={isActivityOpen}
        run={run}
      />
      <MemoryDialog
        memoryActionId={memoryActionId}
        memories={memories}
        memoryLoading={memoryLoading}
        memoryQuery={memoryQuery}
        onAddMemory={handleAddMemory}
        onDeleteMemory={handleDeleteMemory}
        onMemoryQueryChange={setMemoryQuery}
        onOpenChange={setIsMemoryOpen}
        onSearchMemories={handleMemorySearch}
        open={isMemoryOpen}
      />
      <SettingsDialog
        connectionState={connectionState}
        health={health}
        onOpenChange={setIsSettingsOpen}
        onRefreshDiagnostics={handleRefreshDiagnostics}
        open={isSettingsOpen}
        reconnectAttempt={socket.attempt}
      />
    </div>
  );
}

export default App;
