# Helm

Helm is a small, explainable computer-use agent harness for a final-year university project. It owns the task lifecycle, observations, tool execution, verification, retries, loop detection, and persistence. A future language model will propose actions; it will not decide whether an action or task succeeded.

## Stack

- Vite, React, and TypeScript for the UI
- Bun and TypeScript for the backend and guest runtime
- `better-sqlite3`, SQLite FTS5, and an optional `sqlite-vec` adapter
- Zod-validated host/guest protocol
- Playwright with visible Chromium in an XFCE/X11 Linux guest
- Swift and Apple Virtualization.framework on Apple Silicon macOS
- LM Studio through the Vercel AI SDK OpenAI-compatible provider

## Architecture

```text
React UI ──HTTP/WebSocket──> Bun Helm server
                              ├─ SQLite + FTS5
                              ├─ AgentRuntime
                              ├─ ToolRegistry
                              ├─ MemoryService
                              └─ VmController ──JSONL──> Swift VM host
                                                           │
                                                           ├─ Virtualization.framework
                                                           └─ Virtio socket / guest transport
                                                               │
                                                               └─ helm-guest
```

The normal loop is `observe → reason → act → observe → verify`. Completion is always checked by deterministic verifiers.

## Development

```sh
bun install
bun run typecheck
bun test
bun run build
bun run guest:build
bun dev
# or: ./start-helm.sh
```

The server listens on `http://127.0.0.1:8787` and Vite normally listens on `http://127.0.0.1:5173`.

By default Helm reads [`config/models.json`](config/models.json) and connects to an OpenAI-compatible LM Studio server at `http://localhost:1234/v1`. Load the configured language model and embedding model in LM Studio before sending a task. The server does not require an API key for this local connection.

`./start-helm.sh` is the shortcut launcher. It resolves the repository root and delegates to `bun dev`, which starts the Bun backend and Vite frontend in parallel. The VM remains an explicit lifecycle operation and LM Studio is an external service.

## Scripted demo

Start the server, then run:

```sh
bun run demo
```

The scripted provider uses the same runtime, tool registry, verifier, persistence, and event stream as the LM Studio provider. The local fixture is opened, extracted text is carried into `fs.write`, the file is opened in the allowlisted editor, and Helm verifies every criterion before completing the run. Tests use a mock guest transport; VM integration is opt-in.

## VM lifecycle

Build the native helper and inspect the environment with:

```sh
bun run vm:build
bun run vm:doctor
bun run vm:provision /path/to/ubuntu-24.04-arm64.iso
bun run vm:seal
bun run vm:start
bun run vm:start --gui
bun run vm:stop
bun run vm:reset
```

The first-run provisioning command opens a native Virtualization.framework
window for an official Ubuntu 24.04 LTS ARM64 installer. After the guest is
installed and shut down, `vm:seal` promotes the retained installation disk to
`base.img`. `vm:doctor` reports lazy first-run artifacts as `WAIT`; see
[docs/vm-setup.md](docs/vm-setup.md).

`vm:start --gui` starts the normal VM through the server with a resizable
Virtualization.framework viewer window attached. Plain `vm:start` remains
headless. If the helper is already running headlessly, stop it before retrying
with `--gui`.

## Documentation

- [Architecture](docs/architecture.md)
- [Agent loop](docs/agent-loop.md)
- [Guest protocol](docs/guest-protocol.md)
- [VM setup](docs/vm-setup.md)

## Current limitations

This implementation does not extract memories automatically, provide unrestricted shell access, support Windows/Linux-host virtualization, or implement remote desktop streaming. VM tests require a sealed guest image and are guarded by `HELM_VM_INTEGRATION=1`. The LM Studio provider plans tasks and proposes actions, while Helm's runtime remains authoritative for tool execution and verification.
