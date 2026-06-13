# Helm — System Architecture

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        User's Browser                           │
│                                                                 │
│  ┌─────────────────────┐    ┌──────────────────────────────┐   │
│  │   Agent Chat Panel  │    │       VNC Viewer (iframe)    │   │
│  │  (messages, queue,  │    │   live view of Linux desktop  │   │
│  │   status events)    │    └──────────────────────────────┘   │
│  └─────────┬───────────┘                                       │
│            │ SSE stream + REST                                  │
└────────────┼────────────────────────────────────────────────────┘
             │
┌────────────▼────────────────────────────────────────────────────┐
│                      Helm Server  (Bun + Hono)                  │
│                                                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │  REST routes │  │  SSE stream  │  │   Agent runtime      │  │
│  │  /api/...    │  │  run events  │  │   (streamText loop)  │  │
│  └──────┬───────┘  └──────┬───────┘  └──────────┬───────────┘  │
│         │                 │                      │              │
│  ┌──────▼─────────────────▼──────────────────────▼───────────┐ │
│  │               SQLite (better-sqlite3)                      │ │
│  │  conversations · messages · runs · run_events · summaries  │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────┐   ┌──────────────────────────────────┐  │
│  │   Memory service   │   │      Summariser service          │  │
│  │  ChromaDB (HTTP)   │   │  (token estimate → LLM summary)  │  │
│  └────────────────────┘   └──────────────────────────────────┘  │
└─────────────────────────────────┬───────────────────────────────┘
                                  │ Tool calls (HTTP)
┌─────────────────────────────────▼───────────────────────────────┐
│               Linux Desktop Container (Docker)                  │
│                                                                 │
│   Xvfb virtual display  ·  Openbox WM  ·  Firefox              │
│   x11vnc → noVNC (WebSocket) → browser iframe                  │
│                                                                 │
│   Tool endpoints: /screenshot  /mouse  /keyboard  /apps  ...   │
└─────────────────────────────────────────────────────────────────┘
                                  │
┌─────────────────────────────────▼───────────────────────────────┐
│               ChromaDB  (vector store)                          │
│                                                                 │
│   Collections:                                                  │
│     helm_memory    — semantic user/assistant embeddings         │
│     helm_episodes  — episodic run summaries                     │
│     helm_summaries — context window summaries (future)          │
└─────────────────────────────────────────────────────────────────┘
```

## Component Descriptions

### Client (React + Vite)

The frontend is a single-page application. Its core responsibilities are:

- **Conversation management**: creating conversations, browsing history, switching between them.
- **Run lifecycle**: submitting a user goal to the server, opening an SSE stream to receive live events, rendering streaming tool calls, reasoning steps, and assistant text in real time.
- **Message queue**: allowing the user to queue follow-up messages that are delivered automatically once the agent finishes the current run.
- **Memory browser**: listing and inspecting stored memory entries from ChromaDB.
- **Settings**: persisting custom instructions in `localStorage` and sending them with every run.
- **VNC viewer**: embedding a noVNC iframe so the user can watch the agent's actions on the desktop in real time.

### Server (Bun + Hono)

The server is a lightweight HTTP server built on the Hono web framework, running on the Bun JavaScript runtime. It handles:

- **REST API**: conversation CRUD, run start/cancel, message pagination, memory management, server info.
- **SSE streaming**: each run opens a persistent event stream to the client delivering reasoning deltas, tool calls/results, memory events, and completion signals.
- **Agent runtime**: the heart of the system — a `streamText` loop from the Vercel AI SDK that drives the model through the ReAct loop, calling desktop tools and persisting intermediate state.
- **Database**: all persistent state (conversations, messages, runs, run events, summaries) lives in a single SQLite file managed by `better-sqlite3`.
- **Memory services**: after each run, episodic summaries and semantic embeddings are upserted into ChromaDB; relevant embeddings are retrieved at the start of the next run.
- **Summariser**: when the conversation token estimate exceeds `SUMMARY_TRIGGER_TOKENS`, older messages are summarised by the LLM and the summary is stored; subsequent runs inject the summary into the system prompt.

### Desktop Container (Docker)

A Docker container provides an isolated, reproducible Linux GUI environment:

- **Xvfb**: virtual X11 display server (no physical monitor required).
- **Openbox**: lightweight window manager.
- **x11vnc + noVNC**: bridges the X11 display to a WebSocket-based VNC stream that the browser can embed as an iframe.
- **Tool HTTP server**: a small server inside the container exposes endpoints for each tool action (screenshot capture, mouse movement, keyboard input, application launching, terminal execution, file operations). The Helm server calls these endpoints when the agent issues tool calls.

### ChromaDB (Vector Store)

ChromaDB is an open-source embedding database that stores dense vector representations of text. Helm uses three collections:

| Collection | Content | Purpose |
|------------|---------|---------|
| `helm_memory` | Semantic embeddings of user inputs and assistant outputs | Long-term cross-session recall |
| `helm_episodes` | Structured summaries of entire runs (actions taken, outcome) | Episodic memory for similar task contexts |
| `helm_summaries` | Compressed conversation summaries | Context window management |

Embeddings are generated by a configurable local or remote embedding model (`EMBED_MODEL`).

## Request Flow — Starting a Run

```
1. User types goal → POST /api/conversations/:id/runs
2. Server stores user message, creates run record, queues microtask
3. Server responds 202 with run ID
4. Client opens EventSource → GET /api/conversations/:id/runs/:rid/stream
5. Agent runtime begins:
   a. maybeSummarizeConversation() — summarise if over token threshold
   b. queryMemories() + queryRunEpisodes() — RAG retrieval from ChromaDB
   c. buildAgentSystemPrompt() — assemble system prompt with memories & summary
   d. streamText() loop:
      - prepareStep: prune old screenshot images from context
      - model reasons → emits reasoning delta → SSE → client
      - model calls tool → server calls desktop container endpoint
      - tool result streamed back → model sees result → next step
   e. Run completes → upsertRunEpisode() + upsertMemory() → ChromaDB
   f. maybeSummarizeConversation() post-run check
6. SSE 'done' event → client refreshes conversation state
```
