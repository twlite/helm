# Helm

Simple agentic desktop automation using Vision-Language Models, ReAct planning, and episodic memory via RAG.

Helm runs a Linux desktop inside a Docker container and lets a VLM agent control it — clicking, typing, and navigating — until a natural-language goal is fulfilled.

## How it works

1. A virtual desktop (Ubuntu + Xvfb) runs inside Docker, visible via noVNC in the browser.
2. You give the agent a task in plain English.
3. The agent takes a screenshot, reasons about what to do next (ReAct loop), and executes actions via `xdotool`.
4. Past steps are stored as embeddings in ChromaDB so the agent can recall similar situations and avoid repeating mistakes.
5. The loop continues until the goal is reached or the agent gives up.

## Prerequisites

- [Docker](https://www.docker.com/) and Docker Compose
- A running local LLM server that exposes an OpenAI-compatible API:
  - [LM Studio](https://lmstudio.ai/) (default, port `1234`)
  - or [Ollama](https://ollama.com/) (port `11434`)
- A vision + tool-calling capable model loaded in your LLM server (e.g. `qwen2.5vl`, `qwen3.5`)

## Getting started

### 1. Clone the repo

```bash
git clone https://github.com/your-org/helm.git
cd helm
```

### 2. Configure environment

Copy the example env file and edit as needed:

```bash
cp .env.example .env
```

| Variable         | Default                               | Description                                                                    |
| ---------------- | ------------------------------------- | ------------------------------------------------------------------------------ |
| `LLM_BASE_URL`   | `http://host.docker.internal:1234/v1` | Base URL of your OpenAI-compatible LLM server                                  |
| `MODEL_PROVIDER` | `openai`                              | Provider name for Vercel AI SDK (`openai` works for both LM Studio and Ollama) |
| `VLM_MODEL`      | `qwen/qwen3.5-9b`                     | Model name to use (e.g. `qwen2.5vl`, `qwen3.5`)                                |
| `EMBED_MODEL`    | `nomic-embed-text`                    | Embedding model name for RAG                                                   |

> **LM Studio:** Start the local server from the app and make sure your model is loaded before running Helm.
>
> **Ollama:** The default `LLM_BASE_URL` assumes LM Studio. For Ollama, set `LLM_BASE_URL=http://host.docker.internal:11434/v1`.
>
> **Linux hosts:** `host.docker.internal` may not resolve automatically. Add `--add-host=host.docker.internal:host-gateway` to the server service in `docker-compose.yml`, or set `LLM_BASE_URL` to your machine's LAN IP.

### 3. Start everything (production-like)

```bash
docker compose up --build
```

This starts:

- `agent-desktop` — headless Ubuntu desktop (Xvfb + xdotool + Google Chrome)
- `agent-chromadb` — ChromaDB vector store for episodic memory
- `agent-server` — Hono backend + agent loop
- `agent-client` — React frontend

### 4. Open the UI

```
http://localhost:5173
```

The desktop stream and agent conversation panel will be available once all containers are healthy.

## Development (HMR + watch mode)

For day-to-day coding, run the desktop infrastructure in Docker and run app code locally for fast reload.

1. Start only desktop + vector store in Docker:

```bash
docker compose up desktop chromadb
```

2. Install workspace dependencies:

```bash
pnpm install
```

3. Start server in watch mode (Terminal 1):

```bash
pnpm --filter @helm/server dev
```

4. Start client with HMR (Terminal 2):

```bash
pnpm --filter @helm/client dev -- --host 0.0.0.0 --port 5173
```

5. Open:

```text
http://localhost:5173
```

Notes:

- In local dev, the client should call the local server at `http://localhost:3000`.
- `docker compose up --build` uses the production-oriented Docker images (no client HMR).

## Project structure

```
/
├── apps/
│   ├── client/        # React + Vite + Tailwind + shadcn
│   └── server/        # Hono + Vercel AI SDK
├── packages/          # Shared packages
├── agent/
│   └── scripts/
│       └── entrypoint.sh   # Desktop container bootstrap
├── docker-compose.yml
└── package.json
```

## Services and ports

| Service  | Port   | Description                                     |
| -------- | ------ | ----------------------------------------------- |
| Frontend | `5173` | React UI                                        |
| Backend  | `3000` | Hono API + SSE stream                           |
| ChromaDB | `8000` | Vector store (internal + exposed for debugging) |

## Alternative local dev command summary

```bash
pnpm install
pnpm --filter @helm/server dev
pnpm --filter @helm/client dev -- --host 0.0.0.0 --port 5173
```
