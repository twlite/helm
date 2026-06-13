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
  | 'memory_reading'
  | 'memory_saved'
  | 'context_summarizing'
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
  messageCount: number;
  messages: ConversationMessageRecord[];
}

export interface ListConversationsResponse {
  conversations: ConversationRecord[];
}

export interface ConversationEventsResponse {
  events: RunEventRecord[];
  hasMore: boolean;
}

export interface ConversationMessagesPageResponse {
  messages: ConversationMessageRecord[];
  hasMore: boolean;
  nextBeforeCreatedAt: string | null;
  nextBeforeId: string | null;
}

export interface StartRunResponse {
  run: ConversationRunRecord;
}

export interface CreateConversationResponse {
  conversation: ConversationRecord;
}

export interface ApiErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

