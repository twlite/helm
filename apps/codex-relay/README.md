# Codex Relay

`@helm/codex-relay` exposes a small OpenAI-compatible API backed by one long-lived Codex app-server process. It is intended for Helm deployments that want to use the local Codex subscription without running a separate VLM.

The HTTP layer uses Hono and `@hono/node-server`. Chat completions support both regular JSON responses and backpressured Server-Sent Events.

## Run

```sh
RELAY_TOKEN=helm-local pnpm --filter @helm/codex-relay start
```

Useful environment variables:

- `PORT` (default `8787`)
- `HOST` (default `127.0.0.1`)
- `RELAY_TOKEN` (default `helm-local`)
- `CODEX_BIN` (default `codex`)
- `CODEX_CWD` (default `/tmp`)
- `CODEX_MODEL` to select the Codex backend model
- `RELAY_MAX_BODY_BYTES` (default `16777216`)

## Endpoints

- `GET /health` — unauthenticated health check
- `GET /v1/models` — authenticated model listing
- `POST /v1/chat/completions` — authenticated OpenAI-compatible chat completion

Example:

```sh
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Authorization: Bearer helm-local' \
  -H 'Content-Type: application/json' \
  -d '{"model":"codex","messages":[{"role":"user","content":"Hello"}]}'
```
