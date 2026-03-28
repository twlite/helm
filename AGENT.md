# AGENT Playbook

This document helps another coding agent understand how Helm works and how to iterate safely.

## 1) What Helm Is

Helm is an agentic desktop automation system.

- The agent server plans and acts with tool calling.
- A Linux desktop runs in Docker and is shown via noVNC iframe on the client.
- Conversation state is persisted in SQLite (node:sqlite).
- Long-term memory and retrieval use Chroma embeddings.
- Conversation summaries are generated automatically when context grows.

## 2) Monorepo Map

- `apps/server`: Hono API, agent runtime, SQLite + Chroma services.
- `apps/client`: React + Vite UI, AI Elements + shadcn components.
- `packages/desktop`: Desktop control abstraction (mouse, keyboard, screenshot, geometry).
- `docker-compose.yml`: Local stack (desktop, client, server, memory services).
- `.agents/skills`: Local skill references for AI SDK, AI Elements, and React best practices.

## 3) Runtime Data Flow

1. Client creates/selects conversation.
2. Client starts a run with user input.
3. Server appends user message, creates run, streams events over SSE.
4. Agent runtime executes model + tools loop.
5. Tool calls/results and assistant deltas are emitted as run events.
6. Run completion appends assistant message parts (reasoning, tools, text).
7. Summarizer may compress older messages; memory service upserts embeddings.

## 4) API Surface (Server)

Implemented conversation/run APIs:

- `GET /api/health`
- `GET /api/conversations`
- `POST /api/conversations`
- `GET /api/conversations/:conversationId`
- `GET /api/conversations/:conversationId/events`
- `POST /api/conversations/:conversationId/runs`
- `GET /api/conversations/:conversationId/runs/:runId/stream` (SSE)

SSE event names include:

- `run_started`, `status`, `reasoning`, `tool_call`, `tool_result`
- `assistant_text`, `summary_created`, `run_completed`, `run_failed`, `done`

## 5) Persistence Model

SQLite tables in `apps/server/src/database/sqlite.ts`:

- `conversations`
- `conversation_messages`
- `message_parts`
- `conversation_runs`
- `run_events`
- `conversation_summaries`
- `embedding_links`

Key rule: tool outputs can include screenshot payloads (`imageBase64`, `mimeType`) and are persisted in message parts for replay.

## 6) Screenshot Handling

Current behavior:

- Tool `capture_screenshot` returns base64 PNG + mime type.
- Result payload is emitted and persisted via `tool_result`.
- UI renders screenshot preview in conversation tool-result cards.
- Summarization redacts base64 blobs when building transcript text.

When changing screenshot behavior, keep these constraints:

- Do not break persisted message replay.
- Keep transcript/summarizer free of massive raw base64 content.
- Prefer showing image preview + redacted JSON metadata in UI.

## 7) Client Architecture

Desktop agent feature files:

- `use-desktop-agent.ts`: API orchestration and SSE live state.
- `chat-history-panel.tsx`: Left, collapsible conversation history.
- `desktop-vnc-panel.tsx`: Center VNC iframe panel.
- `agent-chat-panel.tsx`: Right conversation panel (messages, reasoning, tools).
- `dashboard-header.tsx`: Header and refresh/status controls.
- `utils.ts` / `types.ts`: shared helpers and state types.

Route:

- `apps/client/src/routes/index.tsx` composes the three-pane layout.

## 8) Environment Variables

Server uses `apps/server/src/config.ts` (zod validated), including:

- `PORT`, `CLIENT_ORIGIN`
- `DB_PATH`, `CHROMA_URL`, collection names
- `LLM_BASE_URL`, `MODEL_PROVIDER`, `VLM_MODEL`, `EMBED_MODEL`
- summarization and context limits (`SUMMARY_*`, `AGENT_*`)

Client:

- `VITE_SERVER_URL`
- `VITE_VNC_EMBED_URL`

## 9) How To Run

Install workspace deps:

- `pnpm install`

Run client:

- `pnpm --filter @helm/client dev`

Run server:

- `pnpm --filter @helm/server dev`

Or run full stack:

- `docker compose up --build`

## 10) Iteration Workflow For Another Agent

1. Read `.agents/skills` references first for stack conventions.
2. Inspect changed files before editing (workspace may be dirty).
3. Implement smallest vertical slice possible.
4. Validate touched package typecheck/dev runtime.
5. Avoid refactoring unrelated files in this repo unless requested.
6. Preserve API contracts used by `use-desktop-agent.ts`.
7. For UI changes, keep AI Elements + shadcn patterns.
8. For server changes, keep SSE event ordering stable.

## 11) Safe Change Checklist

Before finishing a change:

- API responses still match `apps/client/src/lib/api.ts` types.
- SSE stream still emits `done` on terminal events.
- New tool outputs are serializable and persisted.
- Large binary-like fields are not injected into summarizer transcripts.
- No accidental destructive git operations.

## 12) Good Next Improvements

- Add run cancellation endpoint + UI control.
- Add server tests for run lifecycle and SSE replay ordering.
- Add paging/virtualization for very long conversation timelines.
- Add screenshot thumbnail/expand UX with lazy loading.
