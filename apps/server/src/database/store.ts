import { randomUUID } from 'node:crypto';
import type {
  ConversationMessageRecord,
  ConversationRecord,
  ConversationRunRecord,
  ConversationSummaryRecord,
  MessagePartRecord,
  MessagePartType,
  MessageRole,
  RunEventRecord,
  RunEventType,
  RunStatus,
} from '../contracts.ts';
import { db } from '../database/sqlite.ts';

interface SqlRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

interface ConversationRow {
  id: string;
  title: string;
  status: string;
  created_at: string;
  updated_at: string;
  last_preview: string | null;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  run_id: string | null;
  role: string;
  created_at: string;
}

interface PartRow {
  id: string;
  message_id: string;
  conversation_id: string;
  part_type: string;
  position: number;
  content_json: string;
  created_at: string;
}

interface RunRow {
  id: string;
  conversation_id: string;
  status: string;
  error_message: string | null;
  user_message_id: string;
  assistant_message_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface RunEventRow {
  id: string;
  run_id: string;
  conversation_id: string;
  sequence: number;
  event_type: string;
  payload_json: string;
  created_at: string;
}

interface SummaryRow {
  id: string;
  conversation_id: string;
  summary_text: string;
  up_to_message_count: number;
  token_estimate: number;
  created_at: string;
}

interface EmbeddingLinkRow {
  id: string;
  conversation_id: string;
  entity_type: string;
  entity_id: string;
  chroma_collection: string;
  chroma_id: string;
  created_at: string;
}

const isoNow = () => new Date().toISOString();

const toConversationRecord = (row: ConversationRow): ConversationRecord => ({
  id: row.id,
  title: row.title,
  status: row.status as ConversationRecord['status'],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastPreview: row.last_preview,
});

const toRunRecord = (row: RunRow): ConversationRunRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  status: row.status as RunStatus,
  errorMessage: row.error_message,
  userMessageId: row.user_message_id,
  assistantMessageId: row.assistant_message_id,
  startedAt: row.started_at,
  completedAt: row.completed_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const toSummaryRecord = (row: SummaryRow): ConversationSummaryRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  summaryText: row.summary_text,
  upToMessageCount: row.up_to_message_count,
  tokenEstimate: row.token_estimate,
  createdAt: row.created_at,
});

const parseJson = (value: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: value };
  }
};

const toPartRecord = (row: PartRow): MessagePartRecord => ({
  id: row.id,
  messageId: row.message_id,
  conversationId: row.conversation_id,
  partType: row.part_type as MessagePartType,
  position: row.position,
  content: parseJson(row.content_json),
  createdAt: row.created_at,
});

const toRunEventRecord = (row: RunEventRow): RunEventRecord => ({
  id: row.id,
  runId: row.run_id,
  conversationId: row.conversation_id,
  sequence: row.sequence,
  eventType: row.event_type as RunEventType,
  payload: parseJson(row.payload_json),
  createdAt: row.created_at,
});

const toMessageRecord = (
  row: MessageRow,
  parts: MessagePartRecord[],
): ConversationMessageRecord => ({
  id: row.id,
  conversationId: row.conversation_id,
  runId: row.run_id,
  role: row.role as MessageRole,
  createdAt: row.created_at,
  parts,
});

export const withTransaction = <T>(fn: () => T): T => {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = fn();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
};

export const createConversation = (title?: string): ConversationRecord => {
  const now = isoNow();
  const id = randomUUID();

  db.prepare(
    `INSERT INTO conversations (id, title, status, created_at, updated_at, last_preview)
      VALUES (?, ?, ?, ?, ?, NULL)`,
  ).run(id, title?.trim() || 'New task', 'idle', now, now);

  const row = db
    .prepare(
      `SELECT id, title, status, created_at, updated_at, last_preview
       FROM conversations
       WHERE id = ?`,
    )
    .get(id) as unknown as ConversationRow;

  return toConversationRecord(row);
};

export const listConversations = (): ConversationRecord[] => {
  const rows = db
    .prepare(
      `SELECT id, title, status, created_at, updated_at, last_preview
       FROM conversations
       ORDER BY updated_at DESC`,
    )
    .all() as unknown as ConversationRow[];

  return rows.map(toConversationRecord);
};

export const getConversationById = (
  conversationId: string,
): ConversationRecord | null => {
  const row = db
    .prepare(
      `SELECT id, title, status, created_at, updated_at, last_preview
       FROM conversations
       WHERE id = ?`,
    )
    .get(conversationId) as ConversationRow | undefined;

  return row ? toConversationRecord(row) : null;
};

export const deleteConversationById = (conversationId: string): boolean => {
  const result = db
    .prepare(`DELETE FROM conversations WHERE id = ?`)
    .run(conversationId) as SqlRunResult;

  return Number(result.changes ?? 0) > 0;
};

export const getLatestRunForConversation = (
  conversationId: string,
): ConversationRunRecord | null => {
  const row = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        status,
        error_message,
        user_message_id,
        assistant_message_id,
        started_at,
        completed_at,
        created_at,
        updated_at
      FROM conversation_runs
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    )
    .get(conversationId) as RunRow | undefined;

  return row ? toRunRecord(row) : null;
};

export const getConversationTimeline = (
  conversationId: string,
  includeMessages = true,
) => {
  const conversation = getConversationById(conversationId);
  if (!conversation) {
    return null;
  }

  const messageCount = countConversationMessages(conversationId);

  return {
    activeRun: getActiveRunForConversation(conversationId),
    conversation,
    latestSummary: getLatestSummary(conversationId),
    messageCount,
    messages: includeMessages
      ? getMessagesByConversationId(conversationId)
      : [],
  };
};

export const appendMessage = (args: {
  conversationId: string;
  role: MessageRole;
  runId?: string | null;
  parts: Array<{ type: MessagePartType; content: Record<string, unknown> }>;
}): ConversationMessageRecord => {
  const messageId = randomUUID();
  const now = isoNow();

  db.prepare(
    `INSERT INTO conversation_messages (id, conversation_id, run_id, role, created_at)
      VALUES (?, ?, ?, ?, ?)`,
  ).run(messageId, args.conversationId, args.runId ?? null, args.role, now);

  const insertPartStmt = db.prepare(
    `INSERT INTO message_parts (
      id, message_id, conversation_id, part_type, position, content_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const partRecords: MessagePartRecord[] = [];

  for (const [index, part] of args.parts.entries()) {
    const partId = randomUUID();
    insertPartStmt.run(
      partId,
      messageId,
      args.conversationId,
      part.type,
      index,
      JSON.stringify(part.content),
      now,
    );

    partRecords.push({
      id: partId,
      messageId,
      conversationId: args.conversationId,
      partType: part.type,
      position: index,
      content: part.content,
      createdAt: now,
    });
  }

  const previewPart = args.parts.find(
    (part) => part.type === 'text' || part.type === 'attachment',
  );

  const previewText =
    previewPart?.type === 'text' && typeof previewPart.content.text === 'string'
      ? previewPart.content.text.slice(0, 300)
      : previewPart?.type === 'attachment'
        ? `[Attachment] ${
            typeof previewPart.content.filename === 'string'
              ? previewPart.content.filename
              : 'file'
          }`
        : null;

  db.prepare(
    `UPDATE conversations
     SET updated_at = ?, last_preview = COALESCE(?, last_preview)
     WHERE id = ?`,
  ).run(now, previewText, args.conversationId);

  return {
    id: messageId,
    conversationId: args.conversationId,
    runId: args.runId ?? null,
    role: args.role,
    createdAt: now,
    parts: partRecords,
  };
};

export const getMessagesByConversationId = (
  conversationId: string,
): ConversationMessageRecord[] => {
  const messageRows = db
    .prepare(
      `SELECT id, conversation_id, run_id, role, created_at
       FROM conversation_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
    )
    .all(conversationId) as unknown as MessageRow[];

  if (messageRows.length === 0) {
    return [];
  }

  const partRows = db
    .prepare(
      `SELECT id, message_id, conversation_id, part_type, position, content_json, created_at
       FROM message_parts
       WHERE conversation_id = ?
       ORDER BY created_at ASC, position ASC`,
    )
    .all(conversationId) as unknown as PartRow[];

  const groupedParts = new Map<string, MessagePartRecord[]>();

  for (const partRow of partRows) {
    const existing = groupedParts.get(partRow.message_id) ?? [];
    existing.push(toPartRecord(partRow));
    groupedParts.set(partRow.message_id, existing);
  }

  return messageRows.map((messageRow) =>
    toMessageRecord(messageRow, groupedParts.get(messageRow.id) ?? []),
  );
};

export const listConversationMessagesPage = (args: {
  conversationId: string;
  limit: number;
  beforeCreatedAt?: string | null;
  beforeId?: string | null;
}): {
  messages: ConversationMessageRecord[];
  hasMore: boolean;
  nextBeforeCreatedAt: string | null;
  nextBeforeId: string | null;
} => {
  const messageRowsDesc = db
    .prepare(
      `SELECT id, conversation_id, run_id, role, created_at
       FROM conversation_messages
       WHERE conversation_id = ?
         AND (
           ? IS NULL
           OR created_at < ?
           OR (? IS NOT NULL AND created_at = ? AND id < ?)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(
      args.conversationId,
      args.beforeCreatedAt ?? null,
      args.beforeCreatedAt ?? null,
      args.beforeId ?? null,
      args.beforeCreatedAt ?? null,
      args.beforeId ?? null,
      args.limit + 1,
    ) as unknown as MessageRow[];

  const hasMore = messageRowsDesc.length > args.limit;
  const pageRowsDesc = messageRowsDesc.slice(0, args.limit);

  if (pageRowsDesc.length === 0) {
    return {
      messages: [],
      hasMore,
      nextBeforeCreatedAt: null,
      nextBeforeId: null,
    };
  }

  const messageRows = [...pageRowsDesc].reverse();
  const messageIds = messageRows.map((row) => row.id);
  const placeholders = messageIds.map(() => '?').join(', ');

  const partRows = db
    .prepare(
      `SELECT id, message_id, conversation_id, part_type, position, content_json, created_at
       FROM message_parts
       WHERE message_id IN (${placeholders})
       ORDER BY created_at ASC, position ASC`,
    )
    .all(...messageIds) as unknown as PartRow[];

  const groupedParts = new Map<string, MessagePartRecord[]>();

  for (const partRow of partRows) {
    const existing = groupedParts.get(partRow.message_id) ?? [];
    existing.push(toPartRecord(partRow));
    groupedParts.set(partRow.message_id, existing);
  }

  const oldest = messageRows[0];

  return {
    messages: messageRows.map((messageRow) =>
      toMessageRecord(messageRow, groupedParts.get(messageRow.id) ?? []),
    ),
    hasMore,
    nextBeforeCreatedAt: hasMore ? oldest.created_at : null,
    nextBeforeId: hasMore ? oldest.id : null,
  };
};

export const createRun = (args: {
  conversationId: string;
  userMessageId: string;
}): ConversationRunRecord => {
  const id = randomUUID();
  const now = isoNow();

  db.prepare(
    `INSERT INTO conversation_runs (
      id,
      conversation_id,
      status,
      error_message,
      user_message_id,
      assistant_message_id,
      started_at,
      completed_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?)`,
  ).run(id, args.conversationId, 'queued', args.userMessageId, now, now);

  db.prepare(
    `UPDATE conversations
     SET status = 'running', updated_at = ?
     WHERE id = ?`,
  ).run(now, args.conversationId);

  const row = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        status,
        error_message,
        user_message_id,
        assistant_message_id,
        started_at,
        completed_at,
        created_at,
        updated_at
       FROM conversation_runs
       WHERE id = ?`,
    )
    .get(id) as unknown as RunRow;

  return toRunRecord(row);
};

export const getRunById = (runId: string): ConversationRunRecord | null => {
  const row = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        status,
        error_message,
        user_message_id,
        assistant_message_id,
        started_at,
        completed_at,
        created_at,
        updated_at
      FROM conversation_runs
      WHERE id = ?`,
    )
    .get(runId) as RunRow | undefined;

  return row ? toRunRecord(row) : null;
};

export const getActiveRunForConversation = (
  conversationId: string,
): ConversationRunRecord | null => {
  const row = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        status,
        error_message,
        user_message_id,
        assistant_message_id,
        started_at,
        completed_at,
        created_at,
        updated_at
      FROM conversation_runs
      WHERE conversation_id = ?
        AND status IN ('queued', 'running')
      ORDER BY created_at DESC
      LIMIT 1`,
    )
    .get(conversationId) as RunRow | undefined;

  return row ? toRunRecord(row) : null;
};

export const markRunRunning = (runId: string): void => {
  const now = isoNow();

  db.prepare(
    `UPDATE conversation_runs
     SET status = 'running', started_at = ?, updated_at = ?
     WHERE id = ?
       AND status = 'queued'`,
  ).run(now, now, runId);
};

export const markRunCompleted = (args: {
  runId: string;
  conversationId: string;
  assistantMessageId: string;
}): void => {
  const now = isoNow();

  const result = db
    .prepare(
      `UPDATE conversation_runs
       SET status = 'completed', assistant_message_id = ?, completed_at = ?, updated_at = ?
       WHERE id = ?
         AND status = 'running'`,
    )
    .run(args.assistantMessageId, now, now, args.runId) as SqlRunResult;

  if (Number(result.changes ?? 0) === 0) {
    return;
  }

  db.prepare(
    `UPDATE conversations
     SET status = 'completed', updated_at = ?
     WHERE id = ?`,
  ).run(now, args.conversationId);
};

export const markRunFailed = (args: {
  runId: string;
  conversationId: string;
  errorMessage: string;
}): void => {
  const now = isoNow();

  const result = db
    .prepare(
      `UPDATE conversation_runs
       SET status = 'failed', error_message = ?, completed_at = ?, updated_at = ?
       WHERE id = ?
         AND status = 'running'`,
    )
    .run(args.errorMessage, now, now, args.runId) as SqlRunResult;

  if (Number(result.changes ?? 0) === 0) {
    return;
  }

  db.prepare(
    `UPDATE conversations
     SET status = 'failed', updated_at = ?
     WHERE id = ?`,
  ).run(now, args.conversationId);
};

export const markRunCancelled = (args: {
  runId: string;
  conversationId: string;
  errorMessage: string;
}): boolean => {
  const now = isoNow();

  const result = db
    .prepare(
      `UPDATE conversation_runs
       SET status = 'cancelled', error_message = ?, completed_at = ?, updated_at = ?
       WHERE id = ?
         AND status IN ('queued', 'running')`,
    )
    .run(args.errorMessage, now, now, args.runId) as SqlRunResult;

  if (Number(result.changes ?? 0) === 0) {
    return false;
  }

  db.prepare(
    `UPDATE conversations
     SET status = 'cancelled', updated_at = ?
     WHERE id = ?`,
  ).run(now, args.conversationId);

  return true;
};

export const appendRunEvent = (args: {
  runId: string;
  conversationId: string;
  eventType: RunEventType;
  payload: Record<string, unknown>;
}): RunEventRecord => {
  const now = isoNow();

  const maxSeqRow = db
    .prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS max_sequence
       FROM run_events
       WHERE run_id = ?`,
    )
    .get(args.runId) as { max_sequence: number };

  const sequence = Number(maxSeqRow.max_sequence ?? 0) + 1;
  const id = randomUUID();

  db.prepare(
    `INSERT INTO run_events (
      id,
      run_id,
      conversation_id,
      sequence,
      event_type,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.runId,
    args.conversationId,
    sequence,
    args.eventType,
    JSON.stringify(args.payload),
    now,
  );

  return {
    id,
    runId: args.runId,
    conversationId: args.conversationId,
    sequence,
    eventType: args.eventType,
    payload: args.payload,
    createdAt: now,
  };
};

export const listRunEvents = (args: {
  conversationId: string;
  limit: number;
  offset: number;
}): { events: RunEventRecord[]; hasMore: boolean } => {
  const rows = db
    .prepare(
      `SELECT
        id,
        run_id,
        conversation_id,
        sequence,
        event_type,
        payload_json,
        created_at
      FROM run_events
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT ?
      OFFSET ?`,
    )
    .all(
      args.conversationId,
      args.limit + 1,
      args.offset,
    ) as unknown as RunEventRow[];

  const hasMore = rows.length > args.limit;
  const events = rows.slice(0, args.limit).map(toRunEventRecord).reverse();

  return { events, hasMore };
};

export const listRunEventsByRunId = (runId: string): RunEventRecord[] => {
  const rows = db
    .prepare(
      `SELECT
        id,
        run_id,
        conversation_id,
        sequence,
        event_type,
        payload_json,
        created_at
      FROM run_events
      WHERE run_id = ?
      ORDER BY sequence ASC`,
    )
    .all(runId) as unknown as RunEventRow[];

  return rows.map(toRunEventRecord);
};

export const getLatestSummary = (
  conversationId: string,
): ConversationSummaryRecord | null => {
  const row = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        summary_text,
        up_to_message_count,
        token_estimate,
        created_at
      FROM conversation_summaries
      WHERE conversation_id = ?
      ORDER BY created_at DESC
      LIMIT 1`,
    )
    .get(conversationId) as SummaryRow | undefined;

  return row ? toSummaryRecord(row) : null;
};

export const insertSummary = (args: {
  conversationId: string;
  summaryText: string;
  upToMessageCount: number;
  tokenEstimate: number;
}): ConversationSummaryRecord => {
  const id = randomUUID();
  const now = isoNow();

  db.prepare(
    `INSERT INTO conversation_summaries (
      id,
      conversation_id,
      summary_text,
      up_to_message_count,
      token_estimate,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    args.conversationId,
    args.summaryText,
    args.upToMessageCount,
    args.tokenEstimate,
    now,
  );

  return {
    id,
    conversationId: args.conversationId,
    summaryText: args.summaryText,
    upToMessageCount: args.upToMessageCount,
    tokenEstimate: args.tokenEstimate,
    createdAt: now,
  };
};

export const insertEmbeddingLink = (args: {
  conversationId: string;
  entityType: string;
  entityId: string;
  chromaCollection: string;
  chromaId: string;
}): void => {
  const now = isoNow();

  db.prepare(
    `INSERT INTO embedding_links (
      id,
      conversation_id,
      entity_type,
      entity_id,
      chroma_collection,
      chroma_id,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    args.conversationId,
    args.entityType,
    args.entityId,
    args.chromaCollection,
    args.chromaId,
    now,
  );
};

export const listEmbeddingLinksByConversation = (
  conversationId: string,
): Array<{
  id: string;
  conversationId: string;
  entityType: string;
  entityId: string;
  chromaCollection: string;
  chromaId: string;
  createdAt: string;
}> => {
  const rows = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        entity_type,
        entity_id,
        chroma_collection,
        chroma_id,
        created_at
      FROM embedding_links
      WHERE conversation_id = ?`,
    )
    .all(conversationId) as unknown as EmbeddingLinkRow[];

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    chromaCollection: row.chroma_collection,
    chromaId: row.chroma_id,
    createdAt: row.created_at,
  }));
};

export const listAllEmbeddingLinks = (): Array<{
  id: string;
  conversationId: string;
  entityType: string;
  entityId: string;
  chromaCollection: string;
  chromaId: string;
  createdAt: string;
}> => {
  const rows = db
    .prepare(
      `SELECT
        id,
        conversation_id,
        entity_type,
        entity_id,
        chroma_collection,
        chroma_id,
        created_at
      FROM embedding_links
      ORDER BY created_at DESC`,
    )
    .all() as unknown as EmbeddingLinkRow[];

  return rows.map((row) => ({
    id: row.id,
    conversationId: row.conversation_id,
    entityType: row.entity_type,
    entityId: row.entity_id,
    chromaCollection: row.chroma_collection,
    chromaId: row.chroma_id,
    createdAt: row.created_at,
  }));
};

export const deleteEmbeddingLinkById = (id: string): boolean => {
  const result = db
    .prepare('DELETE FROM embedding_links WHERE id = ?')
    .run(id) as SqlRunResult;
  return result.changes > 0;
};

export const countConversationMessages = (conversationId: string): number => {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total
       FROM conversation_messages
       WHERE conversation_id = ?`,
    )
    .get(conversationId) as { total: number };

  return Number(row.total ?? 0);
};

export const updateConversationStatus = (
  conversationId: string,
  status: ConversationRecord['status'],
): void => {
  db.prepare(
    `UPDATE conversations
     SET status = ?, updated_at = ?
     WHERE id = ?`,
  ).run(status, isoNow(), conversationId);
};

export const ensureConversationTitle = (
  conversationId: string,
  fallbackTitle: string,
): void => {
  const row = db
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .get(conversationId) as { title: string } | undefined;

  if (!row) {
    return;
  }

  if (row.title && row.title !== 'New task') {
    return;
  }

  db.prepare(
    `UPDATE conversations
     SET title = ?, updated_at = ?
     WHERE id = ?`,
  ).run(fallbackTitle, isoNow(), conversationId);
};

const AUTO_CONVERSATION_TITLES = new Set([
  'new task',
  'new desktop task',
  'desktop automation task',
]);

export const setConversationTitleIfAuto = (
  conversationId: string,
  nextTitle: string,
): boolean => {
  const trimmedNext = nextTitle.trim();
  if (!trimmedNext) {
    return false;
  }

  const row = db
    .prepare('SELECT title FROM conversations WHERE id = ?')
    .get(conversationId) as { title: string } | undefined;

  if (!row) {
    return false;
  }

  const currentTitle = (row.title ?? '').trim();
  const normalizedCurrent = currentTitle.toLowerCase();

  if (!AUTO_CONVERSATION_TITLES.has(normalizedCurrent)) {
    return false;
  }

  if (currentTitle === trimmedNext) {
    return false;
  }

  const result = db
    .prepare(
      `UPDATE conversations
       SET title = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(trimmedNext, isoNow(), conversationId) as SqlRunResult;

  return Number(result.changes ?? 0) > 0;
};
