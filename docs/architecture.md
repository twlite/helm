# Helm architecture

Helm is intentionally a single backend process with a small number of explicit boundaries.

```text
browser UI
   │ REST + WebSocket
   ▼
Bun server
   ├── repositories ── bun:sqlite
   ├── memory service ── FTS5 / optional sqlite-vec
   ├── AgentRuntime ── LM Studio model ── verifier ── ToolRegistry
   ├── VmController ── guest transport
   └── event hub
          │ JSON Lines
          ▼
Swift VM host ── Virtualization.framework ── ARM64 Linux
                                             └── helm-guest
```

The UI never talks directly to the VM. The server translates UI requests into typed tool calls and emits validated activity events. The guest exposes semantic filesystem, browser, application, and desktop operations rather than a shell.

## Boundaries

- `packages/shared` owns Zod protocol schemas and shared domain types.
- `apps/server/src/db` owns migrations and SQLite repositories.
- `apps/server/src/memory` owns global memory persistence, FTS search, semantic recall, and vector capability reporting. AI runs receive only a small relevant recall set for their source message rather than the entire memory table.
- `apps/server/src/agent` owns the run loop, budgets, loop detection, and provider boundary.
- `apps/server/src/ai` owns the LM Studio OpenAI-compatible model and embedding adapters. It proposes tasks and actions; it never executes tools or decides verification.
- `apps/server/src/tools` owns tool schemas and execution.
- `apps/server/src/vm` hides the helper process and guest transport from the rest of the server.
- `guest/helm-guest` owns operations that must execute inside the isolated Linux desktop.
- `native/helm-vm-host` owns only Virtualization.framework configuration and lifecycle.

The model boundary is intentionally subordinate to Helm's runtime. The AI SDK adapter proposes a validated task plan or one next action from the current observation. Actual execution remains routed through Helm's registry and completion remains owned by Helm's verifier.

## Memory recall

Memories are global, explicitly persisted notes. At the start of an AI run, Helm
uses the source user message to retrieve a small context set through semantic
vector search when available, with FTS keyword fallback. Empty or generic
follow-ups do not trigger semantic recall, and distant vector candidates are
discarded. The same snapshot is supplied to task planning and subsequent
decision turns; the model is instructed to treat it as untrusted reference
material rather than current state or an instruction override.
