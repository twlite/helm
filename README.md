# Helm

Helm is a small, explainable computer-use agent harness for a final-year university project. It owns the task lifecycle, observations, tool execution, verification, retries, loop detection, and persistence. A future language model will propose actions; it will not decide whether an action or task succeeded.

## Stack

- Vite, React, and TypeScript for the UI
- Bun and TypeScript for the backend and guest runtime
- `bun:sqlite`, SQLite FTS5, and an optional `sqlite-vec` adapter
- Zod-validated host/guest protocol
- Playwright with visible Chromium in an XFCE/X11 Linux guest
- Swift and Apple Virtualization.framework on Apple Silicon macOS
- No model provider is configured in this version

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
```

The server listens on `http://127.0.0.1:8787` and Vite normally listens on `http://127.0.0.1:5173`.

The application boots without an API key. Messages persist even when no model is configured, and the UI labels that state explicitly.

## Scripted demo

Start the server, then run:

```sh
bun run demo
```

The scripted provider uses the same runtime, tool registry, verifier, persistence, and event stream as a future model provider. The local fixture is opened, extracted text is carried into `fs.write`, the file is opened in the allowlisted editor, and Helm verifies every criterion before completing the run. Tests use a mock guest transport; VM integration is opt-in.

## VM lifecycle

Build the native helper and inspect the environment with:

```sh
bun run vm:build
bun run vm:doctor
bun run vm:start
bun run vm:stop
bun run vm:reset
```

The native helper expects a prepared ARM64 Linux image. `vm:doctor` reports missing images or helpers rather than treating configuration as proof that a VM is available. See [docs/vm-setup.md](docs/vm-setup.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Agent loop](docs/agent-loop.md)
- [Guest protocol](docs/guest-protocol.md)
- [VM setup](docs/vm-setup.md)

## Current limitations

This implementation deliberately does not connect to a real AI provider, plan tasks from arbitrary natural language, extract memories automatically, provide unrestricted shell access, support Windows/Linux-host virtualization, or implement remote desktop streaming. VM tests require a prepared guest image and are guarded by `HELM_VM_INTEGRATION=1`.
