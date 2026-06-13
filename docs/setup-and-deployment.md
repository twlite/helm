# Helm — Setup and Deployment

## Prerequisites

| Requirement | Version | Notes |
|-------------|---------|-------|
| Docker Desktop | 24+ | Must support compose v2 (`docker compose`) |
| Bun | 1.x | Required for running the server outside Docker |
| Node.js | 20+ | Required for the Vite dev server |
| pnpm | 9+ | Package manager used across the monorepo |

You also need access to:
- A **Vision-Language Model** API compatible with the OpenAI chat completions format (with vision and tool-call support). This can be a local model served by Ollama/LM Studio or a hosted provider.
- An **embedding model** API compatible with the OpenAI embeddings format. This is used for memory storage and retrieval.

## Environment Variables

Create a `.env` file in the repository root or pass these variables to the server process.

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `VLM_MODEL` | Name of the vision-language model to use | `qwen2.5-vl:72b` |
| `LLM_BASE_URL` | Base URL of the OpenAI-compatible model API | `http://localhost:11434/v1` |
| `EMBED_MODEL` | Name of the embedding model | `nomic-embed-text` |
| `MODEL_PROVIDER` | Human-readable provider name (display only) | `Ollama` |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP port for the Helm server |
| `DB_PATH` | `helm.db` | Path to the SQLite database file |
| `CHROMA_URL` | `http://localhost:8000` | ChromaDB HTTP endpoint |
| `AGENT_MAX_STEPS` | `50` | Maximum tool-call steps per run |
| `AGENT_CONTEXT_RECENT_MESSAGES` | `24` | Number of recent messages included in each run's context |
| `SUMMARY_TRIGGER_TOKENS` | `9000` | Token threshold at which context compression triggers |
| `SUMMARY_KEEP_RECENT_MESSAGES` | `10` | Messages preserved verbatim after compression |
| `MEMORY_TOP_K` | `4` | Number of memory entries retrieved per run |
| `MEMORY_COLLECTION` | `helm_memory` | ChromaDB collection for semantic memory |
| `EPISODIC_MEMORY_COLLECTION` | `helm_episodes` | ChromaDB collection for episodic memory |
| `RUN_STREAM_PING_MS` | `15000` | SSE keepalive interval in milliseconds |
| `CLIENT_ORIGIN` | (none) | Allowed CORS origin for the React client |
| `PUBLIC_SERVER_URL` | (none) | Publicly reachable URL for the server (used in generated URLs) |

## Running with Docker Compose

The recommended way to run Helm in a complete environment:

```bash
# Clone the repository
git clone <repo-url>
cd helm

# Configure environment
cp .env.example .env
# Edit .env with your model API credentials

# Start all services
docker compose up --build
```

The compose file starts:
1. **ChromaDB** — vector store, available internally at `http://chroma:8000`
2. **Desktop container** — Linux GUI with VNC, tool HTTP server
3. **Helm server** — the API and agent, available at `http://localhost:3000`

Access the UI by opening `http://localhost:3000` in a browser.

## Running in Development

### 1. Start ChromaDB

```bash
docker compose up chroma -d
```

### 2. Start the desktop container

```bash
docker compose up desktop -d
```

### 3. Install dependencies

```bash
pnpm install
```

### 4. Start the server

```bash
# From the repository root
pnpm --filter server dev
# or
cd apps/server && bun run dev
```

### 5. Start the client dev server

```bash
pnpm --filter client dev
# or
cd apps/client && pnpm dev
```

The Vite dev server runs at `http://localhost:5173` and proxies API requests to the Helm server at `http://localhost:3000`.

## Production Build

```bash
# Build the client
cd apps/client && pnpm build

# The server serves the compiled client from the dist/ directory
cd apps/server && bun run build && bun run start
```

## Accessing the VNC Desktop

The desktop container exposes a noVNC web interface. When embedded in Helm's UI, it appears as the right-side panel of the main dashboard. You can also access it directly in a browser:

```
http://localhost:<VNC_PORT>/vnc.html
```

The default VNC port is configured in the compose file.

## Data Persistence

- **SQLite database**: stored at the path configured by `DB_PATH`. In the Docker Compose setup, this is mounted as a volume.
- **ChromaDB data**: stored in a Docker volume mounted at `/chroma/chroma` inside the container.

To reset all data:
```bash
docker compose down -v   # removes volumes
docker compose up -d
```

## Troubleshooting

### Agent cannot see the desktop

Ensure the desktop container is running and its tool HTTP server is reachable from the Helm server. Check the `DESKTOP_CONTROL_MODE` environment variable and the container logs.

### ChromaDB connection errors

Verify `CHROMA_URL` points to the running ChromaDB instance. The default `http://localhost:8000` works when ChromaDB is running locally; inside Docker, use the service name (`http://chroma:8000`).

### Model API errors

Check that `LLM_BASE_URL` is reachable from the server and that the model specified in `VLM_MODEL` is loaded and supports vision inputs and tool calling.

### Memory not being retrieved

Ensure `CHROMA_URL` is correctly set, the ChromaDB instance is running, and the embedding model is available at the configured endpoint. Check server logs for embedding errors during `upsertMemory` calls.
