export type ConversationStatus =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type MessagePartType =
  | 'text'
  | 'attachment'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'status';

export interface RunAttachmentInput {
  filename: string;
  mediaType?: string;
  url: string;
}

export interface MessagePartRecord {
  id: string;
  messageId: string;
  conversationId: string;
  partType: MessagePartType;
  position: number;
  content: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationMessageRecord {
  id: string;
  conversationId: string;
  runId: string | null;
  role: MessageRole;
  createdAt: string;
  parts: MessagePartRecord[];
}

export interface ConversationRecord {
  id: string;
  title: string;
  status: ConversationStatus;
  createdAt: string;
  updatedAt: string;
  lastPreview: string | null;
}

export interface ConversationRunRecord {
  id: string;
  conversationId: string;
  status: RunStatus;
  errorMessage: string | null;
  userMessageId: string;
  assistantMessageId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type RunEventType =
  | 'run_started'
  | 'status'
  | 'reasoning'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_text'
  | 'summary_created'
  | 'run_completed'
  | 'run_failed'
  | 'run_cancelled';

export interface RunEventRecord {
  id: string;
  runId: string;
  conversationId: string;
  sequence: number;
  eventType: RunEventType;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ConversationSummaryRecord {
  id: string;
  conversationId: string;
  summaryText: string;
  upToMessageCount: number;
  tokenEstimate: number;
  createdAt: string;
}

export interface ConversationTimelineResponse {
  conversation: ConversationRecord;
  activeRun: ConversationRunRecord | null;
  latestSummary: ConversationSummaryRecord | null;
  messages: ConversationMessageRecord[];
}

export interface ConversationMessagesPageResponse {
  messages: ConversationMessageRecord[];
  hasMore: boolean;
  nextBeforeCreatedAt: string | null;
  nextBeforeId: string | null;
}

export type RunReasoningSetting = 'off' | 'low' | 'medium' | 'high' | 'on';

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
  };
}

const API_BASE_URL = import.meta.env.VITE_SERVER_URL ?? 'http://localhost:3000';

const toErrorMessage = (payload: ApiErrorPayload, fallback: string): string => {
  if (payload.error?.message && payload.error.message.trim()) {
    return payload.error.message;
  }

  return fallback;
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    let payload: ApiErrorPayload = {};
    try {
      payload = (await response.json()) as ApiErrorPayload;
    } catch {
      payload = {};
    }

    throw new Error(
      toErrorMessage(payload, `Request failed with status ${response.status}`),
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength === '0') {
    return undefined as T;
  }

  return (await response.json()) as T;
};

export const buildRunStreamUrl = (
  conversationId: string,
  runId: string,
): string => {
  return `${API_BASE_URL}/api/conversations/${conversationId}/runs/${runId}/stream`;
};

export const listConversations = async (): Promise<ConversationRecord[]> => {
  const response = await request<{ conversations: ConversationRecord[] }>(
    '/api/conversations',
  );

  return response.conversations;
};

export const createConversation = async (
  title?: string,
): Promise<ConversationRecord> => {
  const response = await request<{ conversation: ConversationRecord }>(
    '/api/conversations',
    {
      body: JSON.stringify({ title }),
      method: 'POST',
    },
  );

  return response.conversation;
};

export const deleteConversation = async (args: {
  conversationId: string;
}): Promise<void> => {
  await request<void>(`/api/conversations/${args.conversationId}`, {
    body: JSON.stringify({}),
    method: 'DELETE',
  });
};

export const getConversationTimeline = async (
  conversationId: string,
  options?: { includeMessages?: boolean },
): Promise<ConversationTimelineResponse> => {
  const includeMessages = options?.includeMessages;
  const query =
    typeof includeMessages === 'boolean'
      ? `?includeMessages=${includeMessages ? 'true' : 'false'}`
      : '';

  return request<ConversationTimelineResponse>(
    `/api/conversations/${conversationId}${query}`,
  );
};

export const getConversationMessagesPage = async (args: {
  conversationId: string;
  limit?: number;
  beforeCreatedAt?: string | null;
  beforeId?: string | null;
}): Promise<ConversationMessagesPageResponse> => {
  const params = new URLSearchParams();

  if (typeof args.limit === 'number') {
    params.set('limit', String(args.limit));
  }

  if (args.beforeCreatedAt) {
    params.set('beforeCreatedAt', args.beforeCreatedAt);
  }

  if (args.beforeId) {
    params.set('beforeId', args.beforeId);
  }

  const query = params.toString();
  const path = `/api/conversations/${args.conversationId}/messages${query ? `?${query}` : ''}`;

  return request<ConversationMessagesPageResponse>(path);
};

export const startConversationRun = async (args: {
  conversationId: string;
  input?: string;
  attachments?: RunAttachmentInput[];
  reasoning?: RunReasoningSetting;
}): Promise<ConversationRunRecord> => {
  const response = await request<{ run: ConversationRunRecord }>(
    `/api/conversations/${args.conversationId}/runs`,
    {
      body: JSON.stringify({
        attachments: args.attachments ?? [],
        input: args.input ?? '',
        reasoning: args.reasoning,
      }),
      method: 'POST',
    },
  );

  return response.run;
};

export const cancelConversationRun = async (args: {
  conversationId: string;
  runId: string;
}): Promise<ConversationRunRecord> => {
  const response = await request<{ run: ConversationRunRecord }>(
    `/api/conversations/${args.conversationId}/runs/${args.runId}/cancel`,
    {
      body: JSON.stringify({}),
      method: 'POST',
    },
  );

  return response.run;
};
