# Helm Server

Hono API server for agent conversations and run orchestration.

The server stores conversations, messages, tool traces, run events, and summaries in SQLite via `node:sqlite`, and stores semantic memory in ChromaDB for retrieval-augmented context.

## Run

```bash
pnpm --filter @helm/server dev
```

Health endpoint:

```text
GET http://localhost:3000/api/health
```

## API

### Conversations

- `POST /api/conversations`
  - body: `{ "title"?: string }`
  - returns: `{ conversation }`
- `GET /api/conversations`
  - returns: `{ conversations }`
- `GET /api/conversations/:conversationId`
  - returns timeline payload:
    - `conversation`
    - `messages`
    - `activeRun`
    - `latestSummary`
- `GET /api/conversations/:conversationId/events?limit=200&offset=0`
  - returns paginated run events: `{ events, hasMore }`

### Runs

- `POST /api/conversations/:conversationId/runs`
  - body: `{ "input": string }`
  - queues and starts a run
  - returns: `{ run }`
- `GET /api/conversations/:conversationId/runs/:runId/stream`
  - Server-Sent Events stream
  - replays persisted run events first, then pushes live events
  - emits `done` when run ends

## Event types

Run stream emits event names:

- `run_started`
- `status`
- `reasoning`
- `tool_call`
- `tool_result`
- `assistant_text`
- `summary_created`
- `run_completed`
- `run_failed`
- `done`

## Environment

Required:

- `LLM_BASE_URL`
- `MODEL_PROVIDER`
- `VLM_MODEL`
- `EMBED_MODEL`

Common optional variables:

- `PORT` (default `3000`)
- `DB_PATH` (default `helm.db`)
- `CHROMA_URL` (default `http://localhost:8000`)
- `AGENT_MAX_STEPS` (default `12`)
- `AGENT_CONTEXT_RECENT_MESSAGES` (default `24`)
- `SUMMARY_TRIGGER_TOKENS` (default `9000`)
- `SUMMARY_KEEP_RECENT_MESSAGES` (default `10`)
- `MEMORY_TOP_K` (default `4`)
- `MEMORY_COLLECTION` (default `helm_memory`)
- `SUMMARY_COLLECTION` (default `helm_summaries`)
- `RUN_STREAM_PING_MS` (default `15000`)
- `CLIENT_ORIGIN` (optional, for CORS)
- `PUBLIC_SERVER_URL` (optional)

Desktop execution settings:

- `DESKTOP_CONTROL_MODE` (`docker-exec` or `local`)
- `DESKTOP_CONTAINER` (default `agent-desktop`)
- `DESKTOP_DISPLAY` (default `:99`)
- `DESKTOP_COMMAND_TIMEOUT_MS` (default `10000`)
