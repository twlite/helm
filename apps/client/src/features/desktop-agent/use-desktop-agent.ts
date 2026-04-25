import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileUIPart } from 'ai';
import {
  buildRunStreamUrl,
  cancelConversationRun,
  createConversation,
  deleteConversation,
  getConversationMessagesPage,
  getConversationTimeline,
  listConversations,
  startConversationRun,
  type ConversationMessageRecord,
  type ConversationRecord,
  type ConversationTimelineResponse,
  type RunReasoningSetting,
  type RunAttachmentInput,
  type RunEventRecord,
  type RunStatus,
} from '@/lib/api';
import {
  asRecord,
  buildConversationTitle,
  buildVncUrl,
  getText,
} from './utils';
import type { LiveToolCall, LiveToolResult, StreamState } from './types';

const MESSAGE_PAGE_SIZE = 60;

interface MessageCursor {
  beforeCreatedAt: string;
  beforeId: string;
}

const mergeUniqueMessages = (
  messages: ConversationMessageRecord[],
): ConversationMessageRecord[] => {
  const seen = new Set<string>();
  const deduped: ConversationMessageRecord[] = [];

  for (const message of messages) {
    if (seen.has(message.id)) {
      continue;
    }

    seen.add(message.id);
    deduped.push(message);
  }

  return deduped;
};

const toMessageCursor = (args: {
  nextBeforeCreatedAt: string | null;
  nextBeforeId: string | null;
}): MessageCursor | null => {
  if (!args.nextBeforeCreatedAt || !args.nextBeforeId) {
    return null;
  }

  return {
    beforeCreatedAt: args.nextBeforeCreatedAt,
    beforeId: args.nextBeforeId,
  };
};

const toRunAttachments = (files: FileUIPart[]): RunAttachmentInput[] => {
  const attachments: RunAttachmentInput[] = [];

  for (const file of files) {
    const url = typeof file.url === 'string' ? file.url.trim() : '';
    if (!url) {
      continue;
    }

    attachments.push({
      filename: file.filename || 'attachment',
      mediaType: file.mediaType || 'application/octet-stream',
      url,
    });
  }

  return attachments;
};

const sanitizeReasoningDelta = (value: string): string => {
  return value
    .replace(/<\/?tool_call>/gi, '')
    .replace(/<\/?function[^>]*>/gi, '')
    .replace(/<\/?parameter[^>]*>/gi, '')
    .replace(/<\/?tool_call[^>]*>/gi, '');
};

export interface UseDesktopAgentResult {
  conversations: ConversationRecord[];
  activeConversationId: string | null;
  timeline: ConversationTimelineResponse | null;
  messages: ConversationMessageRecord[];
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  loading: boolean;
  error: string | null;
  streamState: StreamState;
  streamError: string | null;
  liveRunId: string | null;
  liveAssistantText: string;
  liveReasoningMessages: string[];
  liveToolCalls: LiveToolCall[];
  liveToolResults: LiveToolResult[];
  isBusy: boolean;
  isCancelling: boolean;
  deletingConversationId: string | null;
  activeTitle: string;
  liveRunStatus: RunStatus | null;
  vncUrl: string;
  refreshActiveTimeline: () => Promise<void>;
  openConversation: (conversationId: string) => Promise<boolean>;
  createAndOpenConversation: () => Promise<boolean>;
  handleDeleteConversation: (conversationId: string) => Promise<void>;
  handleStartRun: (args: {
    text: string;
    files?: FileUIPart[];
    reasoning?: RunReasoningSetting;
  }) => Promise<void>;
  handleCancelRun: () => Promise<void>;
  loadOlderMessages: () => Promise<void>;
}

export const useDesktopAgent = (): UseDesktopAgentResult => {
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<
    string | null
  >(null);
  const [timeline, setTimeline] = useState<ConversationTimelineResponse | null>(
    null,
  );
  const [messages, setMessages] = useState<ConversationMessageRecord[]>([]);
  const [hasMoreMessages, setHasMoreMessages] = useState(false);
  const [messageCursor, setMessageCursor] = useState<MessageCursor | null>(
    null,
  );
  const [loadingOlderMessages, setLoadingOlderMessages] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [streamState, setStreamState] = useState<StreamState>('idle');
  const [streamError, setStreamError] = useState<string | null>(null);
  const [liveRunId, setLiveRunId] = useState<string | null>(null);
  const [liveAssistantText, setLiveAssistantText] = useState('');
  const [liveReasoningMessages, setLiveReasoningMessages] = useState<string[]>(
    [],
  );
  const [liveToolCalls, setLiveToolCalls] = useState<LiveToolCall[]>([]);
  const [liveToolResults, setLiveToolResults] = useState<LiveToolResult[]>([]);
  const [isCancelling, setIsCancelling] = useState(false);
  const [deletingConversationId, setDeletingConversationId] = useState<
    string | null
  >(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const activeStreamRunIdRef = useRef<string | null>(null);
  const seenStreamEventIdsRef = useRef<Set<string>>(new Set());
  const terminalEventHandledRef = useRef(false);
  const liveAssistantBufferRef = useRef('');
  const liveReasoningBufferRef = useRef<string[]>([]);
  const liveFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearLiveBuffers = useCallback(() => {
    if (liveFlushTimerRef.current) {
      clearTimeout(liveFlushTimerRef.current);
      liveFlushTimerRef.current = null;
    }

    liveAssistantBufferRef.current = '';
    liveReasoningBufferRef.current = [];
  }, []);

  const flushLiveBuffers = useCallback(() => {
    if (liveFlushTimerRef.current) {
      clearTimeout(liveFlushTimerRef.current);
      liveFlushTimerRef.current = null;
    }

    const assistantDelta = liveAssistantBufferRef.current;
    const reasoningDeltas = liveReasoningBufferRef.current;

    liveAssistantBufferRef.current = '';
    liveReasoningBufferRef.current = [];

    if (assistantDelta) {
      setLiveAssistantText((prev) => `${prev}${assistantDelta}`);
    }

    if (reasoningDeltas.length > 0) {
      setLiveReasoningMessages((prev) => [...prev, ...reasoningDeltas]);
    }
  }, []);

  const scheduleLiveFlush = useCallback(() => {
    if (liveFlushTimerRef.current) {
      return;
    }

    liveFlushTimerRef.current = setTimeout(() => {
      liveFlushTimerRef.current = null;
      flushLiveBuffers();
    }, 40);
  }, [flushLiveBuffers]);

  const closeEventSource = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }

    activeStreamRunIdRef.current = null;
  }, []);

  const resetLiveState = useCallback(() => {
    clearLiveBuffers();
    setLiveRunId(null);
    setLiveAssistantText('');
    setLiveReasoningMessages([]);
    setLiveToolCalls([]);
    setLiveToolResults([]);
  }, [clearLiveBuffers]);

  const refreshConversations = useCallback(async () => {
    const next = await listConversations();
    setConversations(next);
    return next;
  }, []);

  const refreshTimeline = useCallback(async (conversationId: string) => {
    const next = await getConversationTimeline(conversationId, {
      includeMessages: false,
    });
    setTimeline(next);
    return next;
  }, []);

  const refreshLatestMessages = useCallback(async (conversationId: string) => {
    const page = await getConversationMessagesPage({
      conversationId,
      limit: MESSAGE_PAGE_SIZE,
    });

    setMessages(page.messages);
    setHasMoreMessages(page.hasMore);
    setMessageCursor(toMessageCursor(page));
    return page;
  }, []);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const existing = await refreshConversations();
      let selected = existing[0];

      if (!selected) {
        selected = await createConversation('Desktop automation task');
        const updated = await refreshConversations();
        if (updated.length > 0) {
          selected = updated[0];
        }
      }

      if (!selected) {
        throw new Error('Failed to initialize a conversation.');
      }

      setActiveConversationId(selected.id);
      await Promise.all([
        refreshTimeline(selected.id),
        refreshLatestMessages(selected.id),
      ]);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setLoading(false);
    }
  }, [refreshConversations, refreshLatestMessages, refreshTimeline]);

  useEffect(() => {
    void bootstrap();
    return () => {
      closeEventSource();
      clearLiveBuffers();
    };
  }, [bootstrap, clearLiveBuffers, closeEventSource]);

  const openConversationDirect = useCallback(
    async (conversationId: string) => {
      closeEventSource();
      setStreamState('idle');
      setStreamError(null);
      resetLiveState();
      setMessages([]);
      setHasMoreMessages(false);
      setMessageCursor(null);
      setActiveConversationId(conversationId);
      setError(null);

      try {
        await Promise.all([
          refreshTimeline(conversationId),
          refreshLatestMessages(conversationId),
        ]);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    },
    [closeEventSource, refreshLatestMessages, refreshTimeline, resetLiveState],
  );

  const handleSseEvent = useCallback(
    (event: MessageEvent<string>) => {
      if (event.lastEventId) {
        if (seenStreamEventIdsRef.current.has(event.lastEventId)) {
          return;
        }

        seenStreamEventIdsRef.current.add(event.lastEventId);
      }

      if (!event.data) {
        return;
      }

      if (streamError) {
        setStreamError(null);
      }

      if (event.type === 'done') {
        flushLiveBuffers();
        setStreamError(null);
        setStreamState('idle');
        return;
      }

      let parsed: RunEventRecord;
      try {
        parsed = JSON.parse(event.data) as RunEventRecord;
      } catch {
        return;
      }

      if (parsed.eventType === 'assistant_text') {
        const delta = getText(parsed.payload.delta);
        if (delta) {
          liveAssistantBufferRef.current += delta;
          scheduleLiveFlush();
        }
        return;
      }

      if (parsed.eventType === 'reasoning') {
        const delta = sanitizeReasoningDelta(getText(parsed.payload.delta));
        if (delta) {
          liveReasoningBufferRef.current.push(delta);
          scheduleLiveFlush();
        }
        return;
      }

      if (parsed.eventType === 'tool_call') {
        setLiveToolCalls((prev) => [
          ...prev,
          {
            input: asRecord(parsed.payload.input),
            toolName: getText(parsed.payload.toolName) || 'tool',
          },
        ]);
        return;
      }

      if (parsed.eventType === 'tool_result') {
        setLiveToolResults((prev) => [
          ...prev,
          {
            output: asRecord(parsed.payload.output),
            toolName: getText(parsed.payload.toolName) || 'tool',
          },
        ]);
        return;
      }

      if (
        parsed.eventType === 'run_completed' ||
        parsed.eventType === 'run_failed' ||
        parsed.eventType === 'run_cancelled'
      ) {
        flushLiveBuffers();
        setStreamError(null);
        setStreamState(parsed.eventType === 'run_failed' ? 'error' : 'idle');
      }
    },
    [flushLiveBuffers, scheduleLiveFlush, streamError],
  );

  const startStream = useCallback(
    async (conversationId: string, runId: string) => {
      if (eventSourceRef.current && activeStreamRunIdRef.current === runId) {
        return;
      }

      closeEventSource();
      clearLiveBuffers();
      seenStreamEventIdsRef.current = new Set();
      terminalEventHandledRef.current = false;
      setLiveRunId(runId);
      setStreamState('streaming');
      setStreamError(null);
      setLiveAssistantText('');
      setLiveReasoningMessages([]);
      setLiveToolCalls([]);
      setLiveToolResults([]);

      const streamUrl = buildRunStreamUrl(conversationId, runId);
      const source = new EventSource(streamUrl);
      eventSourceRef.current = source;
      activeStreamRunIdRef.current = runId;

      const eventNames = [
        'assistant_text',
        'reasoning',
        'tool_call',
        'tool_result',
        'status',
        'summary_created',
        'run_started',
        'run_completed',
        'run_failed',
        'run_cancelled',
        'done',
      ];

      for (const name of eventNames) {
        source.addEventListener(name, handleSseEvent as EventListener);
      }

      source.addEventListener('done', () => {
        terminalEventHandledRef.current = true;
        flushLiveBuffers();
        closeEventSource();
        setStreamError(null);
        setStreamState('idle');
        resetLiveState();
        void Promise.all([
          refreshTimeline(conversationId),
          refreshConversations(),
          refreshLatestMessages(conversationId),
        ]);
      });

      source.onerror = () => {
        if (terminalEventHandledRef.current) {
          return;
        }

        if (source.readyState === EventSource.CONNECTING) {
          setStreamError('Run stream reconnecting...');
          return;
        }

        flushLiveBuffers();
        closeEventSource();

        void Promise.all([
          refreshTimeline(conversationId),
          refreshConversations(),
          refreshLatestMessages(conversationId),
        ])
          .then(([nextTimeline]) => {
            const activeRun = nextTimeline.activeRun;

            if (
              !activeRun ||
              activeRun.id !== runId ||
              activeRun.status === 'completed' ||
              activeRun.status === 'failed' ||
              activeRun.status === 'cancelled'
            ) {
              setStreamState(activeRun?.status === 'failed' ? 'error' : 'idle');
              resetLiveState();
              return;
            }

            setStreamState('error');
            setStreamError(
              'Run stream disconnected while still active. Use Refresh or Cancel to recover.',
            );
          })
          .catch(() => {
            setStreamState('error');
            setStreamError(
              'Lost connection to run stream. Refresh to re-sync.',
            );
          });
      };
    },
    [
      clearLiveBuffers,
      closeEventSource,
      flushLiveBuffers,
      handleSseEvent,
      refreshConversations,
      refreshLatestMessages,
      refreshTimeline,
      resetLiveState,
    ],
  );

  useEffect(() => {
    if (!activeConversationId || !timeline?.activeRun) {
      return;
    }

    const run = timeline.activeRun;
    if (run.status === 'queued' || run.status === 'running') {
      void startStream(activeConversationId, run.id);
    }
  }, [activeConversationId, startStream, timeline?.activeRun]);

  const handleStartRun = useCallback(
    async (args: {
      text: string;
      files?: FileUIPart[];
      reasoning?: RunReasoningSetting;
    }) => {
      if (!activeConversationId) {
        return;
      }

      const cleanText = args.text.trim();
      const attachments = toRunAttachments(args.files ?? []);
      const reasoning = args.reasoning;

      if (
        (!cleanText && attachments.length === 0) ||
        streamState === 'streaming' ||
        isCancelling
      ) {
        return;
      }

      setError(null);
      setStreamError(null);

      try {
        const run = await startConversationRun({
          attachments,
          conversationId: activeConversationId,
          input: cleanText,
          reasoning,
        });

        await startStream(activeConversationId, run.id);
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      }
    },
    [activeConversationId, isCancelling, startStream, streamState],
  );

  const handleCancelRun = useCallback(async () => {
    if (!activeConversationId || isCancelling) {
      return;
    }

    const runId = liveRunId ?? timeline?.activeRun?.id;
    if (!runId) {
      return;
    }

    setIsCancelling(true);
    setError(null);
    setStreamError(null);

    try {
      await cancelConversationRun({
        conversationId: activeConversationId,
        runId,
      });

      closeEventSource();
      setStreamState('idle');
      resetLiveState();

      await Promise.all([
        refreshTimeline(activeConversationId),
        refreshConversations(),
        refreshLatestMessages(activeConversationId),
      ]);
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setIsCancelling(false);
    }
  }, [
    activeConversationId,
    closeEventSource,
    isCancelling,
    liveRunId,
    refreshConversations,
    refreshLatestMessages,
    refreshTimeline,
    resetLiveState,
    timeline?.activeRun?.id,
  ]);

  const loadOlderMessages = useCallback(async () => {
    if (
      !activeConversationId ||
      loadingOlderMessages ||
      !hasMoreMessages ||
      !messageCursor
    ) {
      return;
    }

    setLoadingOlderMessages(true);

    try {
      const page = await getConversationMessagesPage({
        beforeCreatedAt: messageCursor.beforeCreatedAt,
        beforeId: messageCursor.beforeId,
        conversationId: activeConversationId,
        limit: MESSAGE_PAGE_SIZE,
      });

      setMessages((prev) => mergeUniqueMessages([...page.messages, ...prev]));
      setHasMoreMessages(page.hasMore);
      setMessageCursor(toMessageCursor(page));
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setLoadingOlderMessages(false);
    }
  }, [
    activeConversationId,
    hasMoreMessages,
    loadingOlderMessages,
    messageCursor,
  ]);

  const confirmAndStopActiveRun = useCallback(
    async (nextConversationId: string | null): Promise<boolean> => {
      if (!activeConversationId) {
        return true;
      }

      const changingConversation =
        nextConversationId === null ||
        nextConversationId !== activeConversationId;

      if (!changingConversation) {
        return true;
      }

      const activeRunStatus = timeline?.activeRun?.status;
      const hasActiveWork =
        streamState === 'streaming' ||
        activeRunStatus === 'queued' ||
        activeRunStatus === 'running';

      if (!hasActiveWork) {
        return true;
      }

      const confirmed = window.confirm(
        'Switching chats will stop and discard the currently running agent. Continue?',
      );

      if (!confirmed) {
        return false;
      }

      await handleCancelRun();
      return true;
    },
    [
      activeConversationId,
      handleCancelRun,
      streamState,
      timeline?.activeRun?.status,
    ],
  );

  const openConversation = useCallback(
    async (conversationId: string): Promise<boolean> => {
      const canSwitch = await confirmAndStopActiveRun(conversationId);
      if (!canSwitch) {
        return false;
      }

      await openConversationDirect(conversationId);
      return true;
    },
    [confirmAndStopActiveRun, openConversationDirect],
  );

  const createAndOpenConversation = useCallback(async (): Promise<boolean> => {
    const canSwitch = await confirmAndStopActiveRun(null);
    if (!canSwitch) {
      return false;
    }

    const conversation = await createConversation('New desktop task');
    await refreshConversations();
    await openConversationDirect(conversation.id);
    return true;
  }, [confirmAndStopActiveRun, openConversationDirect, refreshConversations]);

  const handleDeleteConversation = useCallback(
    async (conversationId: string) => {
      if (deletingConversationId) {
        return;
      }

      const deletingActive = conversationId === activeConversationId;
      setDeletingConversationId(conversationId);
      setError(null);
      setStreamError(null);

      try {
        if (deletingActive) {
          closeEventSource();
          setStreamState('idle');
          resetLiveState();
          setMessages([]);
          setHasMoreMessages(false);
          setMessageCursor(null);
          setTimeline(null);
          setActiveConversationId(null);
        }

        await deleteConversation({ conversationId });
        const next = await refreshConversations();

        if (next.length === 0) {
          const created = await createConversation('New desktop task');
          await refreshConversations();
          await openConversationDirect(created.id);
          return;
        }

        if (deletingActive) {
          await openConversationDirect(next[0].id);
        }
      } catch (nextError) {
        setError(
          nextError instanceof Error ? nextError.message : String(nextError),
        );
      } finally {
        setDeletingConversationId(null);
      }
    },
    [
      activeConversationId,
      closeEventSource,
      deletingConversationId,
      openConversationDirect,
      refreshConversations,
      resetLiveState,
    ],
  );

  const refreshActiveTimeline = useCallback(async () => {
    if (!activeConversationId) {
      return;
    }

    await Promise.all([
      refreshTimeline(activeConversationId),
      refreshLatestMessages(activeConversationId),
    ]);
  }, [activeConversationId, refreshLatestMessages, refreshTimeline]);

  const isBusy = streamState === 'streaming';

  const activeTitle = useMemo(() => {
    if (!timeline) {
      return 'Desktop Agent';
    }

    return buildConversationTitle(timeline.conversation);
  }, [timeline]);

  const vncUrl = useMemo(() => buildVncUrl(), []);
  const liveRunStatus: RunStatus | null = timeline?.activeRun?.status ?? null;

  return {
    activeConversationId,
    activeTitle,
    conversations,
    createAndOpenConversation,
    error,
    handleCancelRun,
    handleDeleteConversation,
    handleStartRun,
    hasMoreMessages,
    isBusy,
    isCancelling,
    deletingConversationId,
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
  };
};
