# Helm — Technology Stack

## Runtime Environments

| Layer | Technology | Version | Purpose |
|-------|-----------|---------|---------|
| Server runtime | Bun | 1.x | JavaScript runtime for the API server; faster startup and native TypeScript support |
| Client bundler | Vite | 6.x | Development server and production build tool |
| Containerisation | Docker + Compose | Latest | Isolates the Linux desktop environment from the host |

## Backend

| Technology | Role |
|-----------|------|
| **Hono** | Web framework — lightweight, edge-compatible HTTP router |
| **Vercel AI SDK** (`ai`) | Drives the LLM interaction — `streamText`, `prepareStep`, tool use |
| **better-sqlite3** | Synchronous SQLite driver for storing conversations, messages, runs, and events |
| **Zod** | Runtime schema validation for environment config and API request bodies |
| **ChromaDB** (HTTP client) | Vector database for storing and querying memory embeddings |
| **Server-Sent Events** (SSE) | One-way push stream delivering live run events to the browser |

### LLM / Embedding Models

Helm is model-agnostic at the API level. Any model compatible with the OpenAI API format (chat completions with vision support and tool calls) can be used by pointing `LLM_BASE_URL` and `VLM_MODEL` at the desired provider. Similarly, `EMBED_MODEL` and a compatible embedding endpoint are used for memory embeddings.

The agent is optimised for models with:
- **Vision support** (required): the model must accept image inputs to reason about screenshots.
- **Tool use** (required): the model must support function/tool calling.
- **Extended reasoning** (optional): if the model supports a reasoning/thinking mode, Helm enables it by default for higher quality multi-step planning.

## Frontend

| Technology | Role |
|-----------|------|
| **React 19** | UI framework |
| **React Router v7** | Client-side routing (`/conversations/:id`, `/memories`) |
| **Tailwind CSS v4** | Utility-first styling |
| **shadcn/ui** | Accessible component library (built on Radix UI primitives) |
| **Radix UI** | Headless accessible primitives (dialogs, collapsibles, tooltips, etc.) |
| **Lucide React** | Icon set |
| **EventSource** (native) | SSE client for receiving live run events |
| **noVNC** (iframe) | WebSocket-based VNC viewer embedded for live desktop view |

### State Management

State is managed with React's built-in hooks (`useState`, `useEffect`, `useCallback`, `useMemo`, `useRef`) — no external state management library is used. The primary state hook `useDesktopAgent` encapsulates:
- Conversation list and active conversation
- Message history with cursor-based pagination
- Live SSE event buffer with 40ms flush interval
- Agent status derivation
- Message queue (ordered list of pending follow-up messages)

### Component Architecture

```
DashboardLayout
├── DashboardHeader
│   └── Settings modal (custom instructions, server info)
├── ResizablePanelGroup
│   ├── Left panel: ChatHistoryPanel | AgentChatPanel
│   │   ├── HistoricalConversationContent
│   │   │   └── renderMessage() per message
│   │   │       ├── ReasoningStepList (collapsible)
│   │   │       ├── ToolActivityGroup (tool call + result + screenshot)
│   │   │       └── StatusChip (expandable memory/summary events)
│   │   ├── LiveConversationContent (streaming)
│   │   ├── MessageQueuePanel (drag-and-drop queue)
│   │   └── PromptInput (composer)
│   └── Right panel: DesktopVncPanel
│       └── animated blue haze overlay (when agent is active)
└── /memories route → MemoriesRoute
    └── MemoryRow (expandable, fetches ChromaDB text on expand)
```

## Data Storage

### SQLite Schema (abbreviated)

```sql
conversations (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,           -- 'idle' | 'running' | 'completed' | 'failed' | 'cancelled'
  created_at TEXT,
  updated_at TEXT
)

messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  run_id TEXT,
  role TEXT,             -- 'user' | 'assistant'
  created_at TEXT
)

message_parts (
  id TEXT PRIMARY KEY,
  message_id TEXT,
  conversation_id TEXT,
  part_type TEXT,        -- 'text' | 'reasoning' | 'tool_call' | 'tool_result' | 'attachment' | 'status'
  position INTEGER,
  content TEXT,          -- JSON-encoded part content
  created_at TEXT
)

runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  status TEXT,           -- 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  user_message_id TEXT,
  assistant_message_id TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT
)

run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  conversation_id TEXT,
  sequence INTEGER,
  event_type TEXT,
  payload TEXT,          -- JSON-encoded event payload
  created_at TEXT
)

conversation_summaries (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  summary_text TEXT,
  up_to_message_count INTEGER,
  token_estimate INTEGER,
  created_at TEXT
)

embedding_links (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  entity_type TEXT,
  entity_id TEXT,
  chroma_collection TEXT,
  chroma_id TEXT,
  created_at TEXT
)
```

### ChromaDB Collections

| Collection | Embedding source | Metadata fields |
|-----------|-----------------|----------------|
| `helm_memory` | User input or assistant output text | `conversationId`, `entityType`, `entityId`, `preview` |
| `helm_episodes` | Structured episode narrative | `conversationId`, `runId`, `toolCallCount`, `success` |
| `helm_summaries` | Conversation summary text | `conversationId`, `summaryId`, `upToMessageCount` |

## DevOps / Deployment

Helm is designed to run entirely via Docker Compose. The compose file orchestrates:

1. **Desktop container**: Linux desktop with Xvfb, Openbox, Firefox, x11vnc, noVNC.
2. **ChromaDB container**: persistent vector store with a mounted volume for data.
3. **Helm server**: the Bun API server with environment variables for model endpoints and API keys.

The React client is either served by the Bun server in production (compiled to static files) or by the Vite dev server during development.
