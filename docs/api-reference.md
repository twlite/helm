# Helm — API Reference

All endpoints are served from the Hono server. The base URL is configurable (`PUBLIC_SERVER_URL`), defaulting to `http://localhost:3000`.

## Conversations

### `GET /api/conversations`

Returns all conversations ordered by creation time (newest first).

**Response** `200`
```json
[
  {
    "id": "string",
    "title": "string",
    "status": "idle | running | completed | failed | cancelled",
    "createdAt": "ISO8601",
    "updatedAt": "ISO8601",
    "lastPreview": "string | null"
  }
]
```

---

### `POST /api/conversations`

Creates a new conversation.

**Body**
```json
{ "title": "string" }
```

**Response** `201`
```json
{ "conversation": { ...ConversationRecord } }
```

---

### `DELETE /api/conversations/:conversationId`

Deletes a conversation and all associated messages, runs, events, and embedding links.

**Response** `200`
```json
{ "ok": true }
```

---

### `GET /api/conversations/:conversationId`

Returns the conversation timeline including the active run (if any), context usage metadata, summary history, and optionally recent messages.

**Query parameters**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `includeMessages` | boolean | `false` | Whether to include the latest message page |

**Response** `200`
```json
{
  "conversation": { ...ConversationRecord },
  "activeRun": { ...ConversationRunRecord } | null,
  "contextSummary": {
    "activeMessageCount": 24,
    "activeTokenEstimate": 18400,
    "compressionPercent": 38,
    "contextWindowTokens": 128000,
    "latestSummaryTokenEstimate": 920,
    "source": "provider",
    "summarizedMessageCount": 18,
    "summarizedTokenEstimate": 11200,
    "summaryCount": 2,
    "summaryTokenEstimate": 1640,
    "totalMessageCount": 42,
    "triggerTokens": 102400,
    "usagePercent": 18
  },
  "latestSummary": { ...ConversationSummaryRecord } | null,
  "messageCount": 42,
  "messages": [ ...ConversationMessageRecord[] ],
  "summaryHistory": [ ...ConversationSummaryRecord[] ]
}
```

---

### `GET /api/conversations/:conversationId/messages`

Paginated message loading with cursor-based navigation.

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `limit` | integer | Page size (max 200) |
| `beforeId` | string | Cursor — return messages before this ID |
| `beforeCreatedAt` | string | Cursor — return messages before this timestamp |

**Response** `200`
```json
{
  "messages": [ ...ConversationMessageRecord[] ],
  "hasMore": true,
  "nextBeforeId": "string | null",
  "nextBeforeCreatedAt": "string | null"
}
```

## Runs

### `POST /api/conversations/:conversationId/runs`

Starts an agent run.

**Body**
```json
{
  "input": "string (max 20000 chars)",
  "instructions": "string (max 4000 chars, optional)",
  "reasoning": "off | low | medium | high | on (optional)",
  "attachments": [
    {
      "filename": "string",
      "mediaType": "string (optional)",
      "url": "string (data URL or remote URL)"
    }
  ]
}
```

Either `input` (non-empty) or at least one attachment must be provided.

**Response** `202`
```json
{
  "run": {
    "id": "string",
    "conversationId": "string",
    "status": "queued",
    "createdAt": "ISO8601"
  }
}
```

---

### `GET /api/conversations/:conversationId/runs/:runId/stream`

Opens a Server-Sent Events stream for live run output. Events are replayed from the server's event log on reconnection, enabling reliable delivery.

**SSE event types**

| Event | Payload | Description |
|-------|---------|-------------|
| `run_started` | `{ runId, startedAt }` | Run has begun executing |
| `reasoning` | `{ delta }` | Incremental reasoning/thinking text |
| `tool_call` | `{ toolName, input }` | Model invoked a tool |
| `tool_result` | `{ toolName, output }` | Tool returned a result |
| `assistant_text` | `{ delta }` | Incremental assistant response text |
| `memory_reading` | `{ count, query }` | RAG retrieval found relevant memories |
| `memory_saved` | `{ toolCallCount }` | Episodic memory persisted after run |
| `context_summarizing` | `{ tokenEstimate, triggerTokens, contextWindowTokens, source, upToMessageCount }` | Context window compression started |
| `summary_created` | `{ summaryId, tokenEstimate, summaryTokenEstimate, upToMessageCount }` | Summary created and stored |
| `run_completed` | `{ assistantMessageId, preview }` | Run finished successfully |
| `run_failed` | `{ message }` | Run encountered an error |
| `run_cancelled` | `{ message }` | Run was cancelled |
| `done` | `{ runId, status }` | Terminal event — stream can be closed |
| `ping` | `{ ts }` | Keepalive (every 15 seconds) |

---

### `POST /api/conversations/:conversationId/runs/:runId/cancel`

Cancels an active run. The cancellation is cooperative — the current tool call completes before the agent stops.

**Response** `200`
```json
{ "run": { ...ConversationRunRecord } }
```

## Memory

### `GET /api/memories`

Lists all stored embedding link records ordered by creation time (newest first).

**Response** `200`
```json
[
  {
    "id": "string",
    "conversationId": "string",
    "entityType": "run_user_input | run_assistant_output | episode",
    "entityId": "string",
    "chromaCollection": "helm_memory | helm_episodes | helm_summaries",
    "chromaId": "string",
    "createdAt": "ISO8601"
  }
]
```

---

### `GET /api/memories/:id/text`

Fetches the stored document text for a memory entry from ChromaDB.

**Response** `200`
```json
{ "text": "string | null" }
```

---

### `DELETE /api/memories/:id`

Deletes a memory entry from both ChromaDB and the SQLite `embedding_links` table.

**Response** `200`
```json
{ "ok": true }
```

## Server Info

### `GET /api/info`

Returns the server's model configuration. Used by the client to display which model is active.

**Response** `200`
```json
{
  "model": "string",
  "provider": "string",
  "embedModel": "string",
  "contextWindowTokens": 32768,
  "summaryTriggerSource": "provider",
  "summaryTriggerTokens": 26214
}
```

## Error Responses

All errors follow a consistent format:

```json
{
  "error": "Human-readable message",
  "code": "machine_readable_code (optional)"
}
```

| HTTP status | Meaning |
|-------------|---------|
| `400` | Bad request — invalid body or parameters |
| `404` | Resource not found |
| `409` | Conflict — e.g. a run is already active for this conversation |
| `500` | Internal server error |
