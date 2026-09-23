import { useCallback, useEffect, useRef, useState } from 'react';
import { helmApi, parseError } from './api';
import { Conversation, type ConversationNotice, type ConversationSendMode } from './components/Conversation';
import { DesktopPanel } from './components/DesktopPanel';
import { MemoryDialog } from './components/MemoryDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { ThreadSidebar } from './components/ThreadSidebar';
import { useHelmWebSocket } from './hooks/useHelmWebSocket';
import type {
  AsyncState,
  ChatProgress,
  ChatToolCall,
  ConnectionState,
  HelmEvent,
  HealthStatus,
  LiveActivity,
  Memory,
  MemoryKind,
  Message,
  RunDetails,
  StreamingAssistantMessage,
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

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const merged = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) merged.set(message.id, message);
  return [...merged.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function toolCallFromEvent(payload: Record<string, unknown>): ChatToolCall | null {
  const action = isRecord(payload.action) ? payload.action : undefined;
  const toolName = asString(action?.tool) ?? asString(payload.toolName);
  const stepIndex = typeof payload.stepIndex === 'number' ? payload.stepIndex : undefined;
  if (!toolName || stepIndex === undefined) return null;
  const input = isRecord(action?.input)
    ? action.input
    : isRecord(payload.toolInput)
      ? payload.toolInput
      : undefined;
  const result = isRecord(payload.toolResult) ? payload.toolResult : undefined;
  const status: ChatToolCall['status'] = result
    ? result.ok === false ? 'failed' : 'succeeded'
    : 'running';
  return {
    stepIndex,
    toolName,
    ...(input ? { input } : {}),
    status,
  };
}

function chatProgressFromRun(run: RunDetails): ChatProgress {
  const toolCalls = run.steps.flatMap((step) => {
    if (step.phase !== 'act' || !step.toolName) return [];
    return [{
      stepIndex: step.stepIndex,
      toolName: step.toolName,
      ...(step.toolInput ? { input: step.toolInput } : {}),
      status: step.toolResult
        ? step.toolResult.ok ? 'succeeded' : 'failed'
        : 'running',
    } satisfies ChatToolCall];
  });
  return { runId: run.id, summaries: [], toolCalls };
}

function mergeChatProgress(current: ChatProgress | null, run: RunDetails): ChatProgress {
  const saved = chatProgressFromRun(run);
  if (current?.runId !== run.id) return saved;

  const toolCalls = new Map(saved.toolCalls.map((call) => [call.stepIndex, call]));
  for (const call of current.toolCalls) {
    const persisted = toolCalls.get(call.stepIndex);
    if (!persisted || call.status === 'running') toolCalls.set(call.stepIndex, call);
  }
  return {
    runId: run.id,
    summaries: current.summaries,
    toolCalls: [...toolCalls.values()].sort((left, right) => left.stepIndex - right.stepIndex),
  };
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
    uncleanShutdownDetected: typeof source.uncleanShutdownDetected === 'boolean'
      ? source.uncleanShutdownDetected
      : previous?.uncleanShutdownDetected,
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

function liveActivityFromEvent(event: HelmEvent, previous: LiveActivity | null): LiveActivity | null {
  if (!event.runId) return previous;
  const payload = isRecord(event.payload) ? event.payload : undefined;
  const stepIndex = typeof payload?.stepIndex === 'number' ? payload.stepIndex : undefined;
  const action = isRecord(payload?.action) ? payload.action : undefined;
  const toolName = typeof action?.tool === 'string'
    ? action.tool
    : typeof payload?.toolName === 'string'
      ? payload.toolName
      : undefined;
  const reasoningSummary = typeof payload?.reasoningSummary === 'string' ? payload.reasoningSummary : undefined;

  switch (event.type) {
    case 'run.started':
      return { runId: event.runId, phase: 'starting' };
    case 'run.step.started':
      return {
        runId: event.runId,
        phase: 'thinking',
        ...(stepIndex === undefined ? {} : { stepIndex }),
      };
    case 'run.verification':
      return {
        runId: event.runId,
        phase: 'verifying',
        ...(previous?.runId === event.runId && previous.stepIndex !== undefined ? { stepIndex: previous.stepIndex } : {}),
      };
    case 'run.step.completed':
      return {
        runId: event.runId,
        phase: 'recorded',
        ...(stepIndex === undefined && previous?.runId === event.runId && previous.stepIndex !== undefined ? { stepIndex: previous.stepIndex } : stepIndex === undefined ? {} : { stepIndex }),
        ...(toolName ? { toolName } : {}),
        ...(reasoningSummary ? { reasoningSummary } : {}),
      };
    case 'run.completed':
      return { runId: event.runId, phase: 'completed' };
    case 'run.failed':
      return { runId: event.runId, phase: 'failed' };
    case 'run.cancelled':
      return { runId: event.runId, phase: 'cancelled' };
    default:
      return previous;
  }
}

function liveActivityFromRun(run: RunDetails, previous: LiveActivity | null): LiveActivity {
  if (run.status === 'completed') return { runId: run.id, phase: 'completed' };
  if (run.status === 'failed' || run.status === 'blocked') return { runId: run.id, phase: 'failed' };
  if (run.status === 'cancelled') return { runId: run.id, phase: 'cancelled' };
  if (run.status === 'pending') {
    return previous?.runId === run.id ? previous : { runId: run.id, phase: 'starting' };
  }

  const latestStep = [...run.steps].sort((left, right) => (
    left.stepIndex - right.stepIndex
    || new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
  )).at(-1);
  if (!latestStep) {
    return previous?.runId === run.id ? previous : { runId: run.id, phase: 'starting' };
  }
  const toolName = latestStep.toolName
    ?? (latestStep.decision?.type === 'action' ? latestStep.decision.tool : undefined)
    ?? latestStep.workerResult?.actions.at(-1)?.tool;
  const reasoningSummary = latestStep.decision?.reasoningSummary
    ?? latestStep.orchestratorDecision?.reasoningSummary
    ?? latestStep.workerResult?.reasoningSummary;
  return {
    runId: run.id,
    phase: latestStep.phase === 'verify' ? 'verifying' : 'thinking',
    stepIndex: latestStep.stepIndex,
    ...(toolName ? { toolName } : {}),
    ...(reasoningSummary ? { reasoningSummary } : {}),
  };
}

function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [messageState, setMessageState] = useState<AsyncState>('idle');
  const [isRunStarting, setIsRunStarting] = useState(false);
  const [isRetryingRun, setIsRetryingRun] = useState(false);
  const [regeneratingTitleThreadId, setRegeneratingTitleThreadId] = useState<string | null>(null);
  const [run, setRun] = useState<RunDetails | null>(null);
  const [liveActivity, setLiveActivity] = useState<LiveActivity | null>(null);
  const [chatProgress, setChatProgress] = useState<ChatProgress | null>(null);
  const [streamingAssistant, setStreamingAssistant] = useState<StreamingAssistantMessage | null>(null);
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
  const [vm, setVm] = useState<VmStatus | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [vmAction, setVmAction] = useState<VmAction | null>(null);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoryQuery, setMemoryQuery] = useState('');
  const [memoryLoading, setMemoryLoading] = useState(false);
  const [memoryActionId, setMemoryActionId] = useState<string | null>(null);
  const [notice, setNotice] = useState<ConversationNotice | null>(null);
  const [isMemoryOpen, setIsMemoryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  const selectedThreadIdRef = useRef<string | null>(null);
  const runRequestRef = useRef(0);
  const runThreadByIdRef = useRef(new Map<string, string>());
  const messageSendInFlightRef = useRef(false);
  const streamingAssistantRef = useRef<StreamingAssistantMessage | null>(null);
  selectedThreadIdRef.current = selectedThreadId;
  streamingAssistantRef.current = streamingAssistant;

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
      if (!currentThreadId || !nextRun.threadId || currentThreadId !== nextRun.threadId) {
        return;
      }
      runThreadByIdRef.current.set(nextRun.id, nextRun.threadId);
      setRun(nextRun);
      setLiveActivity((current) => liveActivityFromRun(nextRun, current));
      setChatProgress((current) => mergeChatProgress(current, nextRun));
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
    if (event.runId && event.type === 'run.started') {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const threadId = asString(payload?.threadId);
      if (threadId) {
        runThreadByIdRef.current.set(event.runId, threadId);
        if (threadId === selectedThreadIdRef.current) {
          setChatProgress({ runId: event.runId, summaries: [], toolCalls: [] });
        }
      }
    }
    if (event.runId && event.type === 'run.progress') {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const threadId = runThreadByIdRef.current.get(event.runId) ?? asString(payload?.threadId);
      const summary = asString(payload?.summary)?.trim();
      if (threadId === selectedThreadIdRef.current && summary) {
        setChatProgress((current) => {
          const base: ChatProgress = current && current.runId === event.runId
            ? current
            : { runId: event.runId!, summaries: [], toolCalls: [] };
          if (base.summaries.at(-1) === summary) return base;
          return { ...base, summaries: [...base.summaries, summary].slice(-8) };
        });
      }
    }
    if (event.runId && (event.type === 'run.step.started' || event.type === 'run.step.completed')) {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const toolCall = payload ? toolCallFromEvent(payload) : null;
      const threadId = runThreadByIdRef.current.get(event.runId);
      if (threadId === selectedThreadIdRef.current && toolCall) {
        const nextCall = event.type === 'run.step.started'
          ? { ...toolCall, status: 'running' as const }
          : toolCall;
        setChatProgress((current) => {
          const base: ChatProgress = current && current.runId === event.runId
            ? current
            : { runId: event.runId!, summaries: [], toolCalls: [] };
          const calls = new Map(base.toolCalls.map((call) => [call.stepIndex, call]));
          calls.set(nextCall.stepIndex, nextCall);
          return {
            ...base,
            toolCalls: [...calls.values()].sort((left, right) => left.stepIndex - right.stepIndex),
          };
        });
      }
    }
    if (event.type === 'assistant.message.started') {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const threadId = asString(payload?.threadId);
      const messageId = asString(payload?.messageId);
      if (threadId && messageId && threadId === selectedThreadIdRef.current && event.runId) {
        setStreamingAssistant({
          threadId,
          runId: event.runId,
          messageId,
          content: '',
          status: 'writing',
        });
      }
    }
    if (event.type === 'assistant.message.delta') {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const messageId = asString(payload?.messageId);
      const delta = asString(payload?.delta);
      if (messageId && delta) {
        setStreamingAssistant((current) => current?.messageId === messageId
          ? { ...current, content: `${current.content}${delta}`, status: 'writing' }
          : current);
      }
    }
    if (event.type === 'assistant.message.finished') {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const messageId = asString(payload?.messageId);
      if (messageId) {
        setStreamingAssistant((current) => current?.messageId === messageId ? { ...current, status: 'finished' } : current);
      }
    }
    if (event.type === 'message.created') {
      const payload = isRecord(event.payload) ? event.payload : undefined;
      const threadId = asString(payload?.threadId);
      const messageId = asString(payload?.id);
      if (messageId && streamingAssistantRef.current?.messageId === messageId) {
        setStreamingAssistant(null);
      }
      if (threadId && threadId === selectedThreadIdRef.current) {
        void helmApi.listMessages(threadId)
          .then((nextMessages) => {
            if (selectedThreadIdRef.current === threadId) {
              setMessages((current) => mergeMessages(current, nextMessages));
            }
          })
          .catch(() => undefined);
      }
      // The server generates a new thread's title after the run finishes, so
      // refresh the lightweight thread list when the durable reply arrives.
      void helmApi.listThreads().then(setThreads).catch(() => undefined);
    }
    if (event.runId && event.type.startsWith('run.')) {
      setLiveActivity((current) => liveActivityFromEvent(event, current));
      void refreshRun(event.runId);
      if (['run.completed', 'run.failed', 'run.cancelled'].includes(event.type)) {
        if (event.type !== 'run.completed' && streamingAssistantRef.current?.runId === event.runId) {
          setStreamingAssistant(null);
        }
        const currentThreadId = selectedThreadIdRef.current;
        if (currentThreadId) {
          void helmApi.listMessages(currentThreadId)
            .then((nextMessages) => setMessages((current) => mergeMessages(current, nextMessages)))
            .catch(() => undefined);
        }
      }
    }
  }, [refreshRun]);

  const socket = useHelmWebSocket(handleEvent);

  useEffect(() => {
    if (socket.connectionVersion === 0) return;
    let cancelled = false;
    void Promise.allSettled([helmApi.health(), helmApi.vmStatus()]).then(([healthResult, vmResult]) => {
      if (cancelled) return;
      if (healthResult.status === 'fulfilled') {
        setHealth(healthResult.value);
        setVm(healthResult.value.vm);
        if (healthResult.value.vm.screenshot) setScreenshot(healthResult.value.vm.screenshot);
      }
      if (vmResult.status === 'fulfilled') {
        setVm(vmResult.value);
        if (vmResult.value.screenshot) setScreenshot(vmResult.value.screenshot);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [socket.connectionVersion]);

  useEffect(() => {
    const activeRunId = run?.id;
    const activeRunStatus = run?.status;
    if (!activeRunId || (activeRunStatus !== 'pending' && activeRunStatus !== 'running')) return;

    let cancelled = false;
    const poll = () => {
      if (!cancelled) void refreshRun(activeRunId);
    };
    poll();
    const interval = window.setInterval(poll, 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [refreshRun, run?.id, run?.status, socket.connectionVersion]);

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
    setLiveActivity(null);
    setChatProgress(null);
    setStreamingAssistant(null);
    setDraft('');
    setNotice(null);
  }, []);

  const handleCreateThread = useCallback(() => {
    selectedThreadIdRef.current = null;
    setSelectedThreadId(null);
    setMessages([]);
    setDraft('');
    setRun(null);
    setLiveActivity(null);
    setChatProgress(null);
    setStreamingAssistant(null);
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
        setLiveActivity(null);
        setChatProgress(null);
        setStreamingAssistant(null);
      }
    } catch (error) {
      showError(error);
    }
  }, [showError, threads]);

  const handleRegenerateThreadTitle = useCallback(async (threadId: string) => {
    if (regeneratingTitleThreadId === threadId) return;
    setRegeneratingTitleThreadId(threadId);
    setNotice(null);
    try {
      const threadMessages = selectedThreadIdRef.current === threadId
        ? messages
        : await helmApi.listMessages(threadId);
      const sourceMessage = threadMessages.find((message) => message.role === 'user');
      if (!sourceMessage) {
        setNotice({ tone: 'info', message: 'This thread has no user message to use for a title.' });
        return;
      }
      const updatedThread = await helmApi.generateThreadTitle(threadId, sourceMessage.id, true);
      setThreads((current) => current.map((thread) => thread.id === updatedThread.id ? updatedThread : thread));
    } catch (error) {
      showError(error);
    } finally {
      setRegeneratingTitleThreadId((current) => current === threadId ? null : current);
    }
  }, [messages, regeneratingTitleThreadId, showError]);

  const handleSendMessage = useCallback(async (content: string, mode: ConversationSendMode) => {
    if (messageSendInFlightRef.current) return;
    messageSendInFlightRef.current = true;
    setMessageState('saving');
    setNotice(null);
    try {
      let threadId = selectedThreadIdRef.current;
      const currentRun = run;
      const runIsActive = currentRun?.status === 'pending'
        || currentRun?.status === 'running'
        || streamingAssistant?.status === 'writing';
      if (!threadId) {
        const thread = await helmApi.createThread(fallbackThreadTitle(content));
        threadId = thread.id;
        selectedThreadIdRef.current = thread.id;
        setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
        setSelectedThreadId(thread.id);
        setMessages([]);
        setRun(null);
        setLiveActivity(null);
        setChatProgress(null);
        setStreamingAssistant(null);
      }
      const message = await helmApi.createMessage(threadId, content);
      setMessages((current) => mergeMessages(current, [message]));
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, updatedAt: message.createdAt } : thread));
      setDraft('');
      setMessageState('idle');
      // The server captures explicit and model-selected durable memories
      // before this request returns. Refresh an open Memory view immediately.
      void helmApi.listMemories(memoryQuery || undefined).then(setMemories).catch(() => undefined);
      try {
        if (mode === 'steer' && currentRun && ['pending', 'running'].includes(currentRun.status)) {
          await helmApi.steerRun(currentRun.id, message.id);
          setNotice({ tone: 'info', message: 'Steering added. Helm will use it before the next action.' });
          return;
        }
        if (mode === 'queue' && runIsActive) {
          const queued = await helmApi.queueAgent(threadId, message.id);
          const queuedRun = queued.run;
          if (queuedRun) {
            runThreadByIdRef.current.set(queuedRun.id, queuedRun.threadId);
            setRun((current) => current && current.id === queuedRun.id && current.steps.length > queuedRun.steps.length ? current : queuedRun);
            setLiveActivity((current) => current && current.runId === queuedRun.id && current.phase !== 'starting' ? current : { runId: queuedRun.id, phase: 'starting' });
            setChatProgress((current) => current?.runId === queuedRun.id ? current : chatProgressFromRun(queuedRun));
          }
          setNotice({
            tone: 'info',
            message: queued.queued ? `Queued behind the current run${queued.position > 0 ? ` · position ${queued.position}` : ''}.` : 'Helm started the queued message.',
          });
          return;
        }
        const nextRun = await helmApi.runAgent(threadId, message.id);
        runThreadByIdRef.current.set(nextRun.id, nextRun.threadId);
        setRun((current) => current?.id === nextRun.id && current.steps.length > nextRun.steps.length ? current : nextRun);
        setLiveActivity((current) => current?.runId === nextRun.id && current.phase !== 'starting' ? current : { runId: nextRun.id, phase: 'starting' });
        setChatProgress((current) => current?.runId === nextRun.id ? current : chatProgressFromRun(nextRun));
      } catch (error) {
        showError(error);
      }
    } catch (error) {
      setMessageState('error');
      showError(error);
    } finally {
      messageSendInFlightRef.current = false;
    }
  }, [memoryQuery, run, showError, streamingAssistant]);

  const handleRunDemo = useCallback(async () => {
    const threadId = selectedThreadIdRef.current;
    if (!threadId) {
      return;
    }
    setIsRunStarting(true);
    setNotice(null);
    try {
      const nextRun = await helmApi.runScriptedDemo(threadId);
      runThreadByIdRef.current.set(nextRun.id, nextRun.threadId);
      setRun((current) => current?.id === nextRun.id && current.steps.length > nextRun.steps.length ? current : nextRun);
      setLiveActivity((current) => current?.runId === nextRun.id && current.phase !== 'starting' ? current : { runId: nextRun.id, phase: 'starting' });
      setChatProgress((current) => current?.runId === nextRun.id ? current : chatProgressFromRun(nextRun));
    } catch (error) {
      showError(error);
    } finally {
      setIsRunStarting(false);
    }
  }, [showError]);

  const handleCancelRun = useCallback(async (runId: string) => {
    setStoppingRunId(runId);
    try {
      await helmApi.cancelRun(runId);
      await refreshRun(runId);
    } catch (error) {
      showError(error);
    } finally {
      setStoppingRunId((current) => current === runId ? null : current);
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
      runThreadByIdRef.current.set(nextRun.id, nextRun.threadId);
      setRun((current) => current?.id === nextRun.id && current.steps.length > nextRun.steps.length ? current : nextRun);
      setLiveActivity((current) => current?.runId === nextRun.id && current.phase !== 'starting' ? current : { runId: nextRun.id, phase: 'starting' });
      setChatProgress((current) => current?.runId === nextRun.id ? current : chatProgressFromRun(nextRun));
    } catch (error) {
      showError(error);
    } finally {
      setIsRetryingRun(false);
    }
  }, [isRetryingRun, messages, run, showError]);

  const handleOpenActivity = useCallback(async (runId?: string) => {
    if (!runId || run?.id === runId) {
      return;
    }
    try {
      const nextRun = await helmApi.getRun(runId);
      runThreadByIdRef.current.set(nextRun.id, nextRun.threadId);
      setRun(nextRun);
      setChatProgress(chatProgressFromRun(nextRun));
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
      // A guest-readiness failure is returned as an API error even though the
      // native VM remains running. Refresh the authoritative VM status so the
      // desktop panel still exposes that state when websocket events are not
      // available.
      const currentVm = await helmApi.vmStatus().catch(() => undefined);
      if (currentVm) {
        setVm(currentVm);
        setHealth((current) => current ? { ...current, vm: currentVm } : current);
        if (currentVm.screenshot) {
          setScreenshot(currentVm.screenshot);
        }
      }
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
  const isRunActive = run?.status === 'pending'
    || run?.status === 'running'
    || streamingAssistant?.status === 'writing';

  return (
    <div className="flex h-dvh min-h-0 w-full overflow-hidden bg-[var(--app-bg)] font-sans text-[var(--text)]">
      <ThreadSidebar
        connectionState={connectionState}
        onCreateThread={handleCreateThread}
        onDeleteThread={handleDeleteThread}
        onRegenerateThreadTitle={handleRegenerateThreadTitle}
        regeneratingTitleThreadId={regeneratingTitleThreadId}
        onMobileOpenChange={setIsMobileSidebarOpen}
        onOpenMemory={() => {
          setIsMemoryOpen(true);
        }}
        onOpenSettings={() => {
          setIsSettingsOpen(true);
        }}
        onSelectThread={handleSelectThread}
        reconnectAttempt={socket.attempt}
        selectedThreadId={selectedThreadId}
        threads={threads}
        mobileOpen={isMobileSidebarOpen}
      />
      <section className="flex min-w-0 flex-1 overflow-hidden">
        <Conversation
          draft={draft}
          isLoading={messageState === 'loading'}
          isRunStarting={isRunStarting}
          isRetryingRun={isRetryingRun}
          isRunActive={isRunActive}
          isSending={messageState === 'saving'}
          isStoppingRun={stoppingRunId !== null && stoppingRunId === run?.id}
          chatProgress={chatProgress}
          messages={messages}
          onCancelRun={handleCancelRun}
          onDraftChange={setDraft}
          onDismissNotice={() => setNotice(null)}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
          onOpenActivity={(runId) => void handleOpenActivity(runId)}
          onRunDemo={handleRunDemo}
          onRetryRun={handleRetryRun}
          onSend={handleSendMessage}
          notice={notice}
          run={run}
          streamingAssistant={streamingAssistant}
          thread={selectedThread}
        />
        <DesktopPanel
          isRetryingRun={isRetryingRun}
          liveActivity={liveActivity ?? undefined}
          onCancelRun={handleCancelRun}
          onRetryRun={handleRetryRun}
          onVmAction={handleVmAction}
          run={run}
          screenshot={screenshot}
          vm={vm}
          vmAction={vmAction}
        />
      </section>
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
