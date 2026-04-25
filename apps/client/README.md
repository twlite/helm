# Helm Client

React + Vite frontend for desktop agent control and run monitoring.

UI layout:

- Collapsible chat history panel
- Desktop VNC embed iframe
- Agent conversation panel with:
  - message stream
  - chain-of-thought sections
  - tool call/result cards
  - live SSE updates

## Run

```bash
pnpm --filter @helm/client dev -- --host 0.0.0.0 --port 5173
```

## Environment

Use a local `.env` file in `apps/client`.

- `VITE_SERVER_URL` (default: `http://localhost:3000`)
- `VITE_VNC_EMBED_URL` (default: `http://localhost:6080/vnc.html`)

The desktop iframe source is rendered as:

```text
$VITE_VNC_EMBED_URL?autoconnect=true&reconnect=true&resize=scale&path=websockify
```

## Key behavior

- Automatically creates a conversation when none exists.
- Starts a run from prompt input and connects to SSE stream.
- Replays previous run events and continues with live events.
- Re-syncs timeline data after run completion/failure.
- Shows server-produced summaries when context compression triggers.
