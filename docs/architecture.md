# Helm architecture

Helm is a single backend process with explicit boundaries. The model proposes
objectives and bounded actions; the runtime owns execution, state, evidence,
verification, and completion.

```text
browser UI -- REST + WebSocket --> Bun server
                                   |- task compiler -> requirements
                                   |- orchestrator -> one objective
                                   |- bounded worker -> ToolRegistry
                                   |- evidence/fact store -> verifier
                                   |- repositories -> better-sqlite3
                                   `- VmController -> typed guest transport
                                                        | JSON Lines
                                                        v
                                             Swift VM host -> helm-guest
                                                              |- Playwright
                                                              `- desktop/filesystem
```

## Responsibilities

- `packages/shared` owns domain types and Zod guest protocol schemas.
- `apps/server/src/agent` owns task state, orchestration, worker boundaries,
  runtime budgets, progress fingerprints, recovery, and completion.
- `apps/server/src/ai` owns LM Studio adapters. The compiler, orchestrator, and
  workers can use the same model, but each has a separate schema, prompt, and
  responsibility.
- `apps/server/src/tools` owns typed tool validation, guest calls, and action
  receipts.
- `apps/server/src/db` persists task/state snapshots and structured run-step
  observability.
- `guest/helm-guest` performs sandboxed filesystem, visible-browser, and desktop
  operations.
- `apps/web` renders persisted and live objectives, actions, facts, progress,
  and verification; it does not infer completion from UI state.

## Model boundaries

The task compiler answers “what requirements did the user request?” without
choosing a rigid action sequence. The orchestrator answers “which one unmet
objective should be attempted next?” A worker answers “which bounded tool
actions can achieve that objective?” Runtime receipts answer “what happened?”
The verifier answers “does that evidence satisfy the exact requirement?”

No model response can promote its own guess into authoritative environment
state, redefine requirements, or finish the entire run.

## Redesign mapping

The former path coupled one model decision, one tool call, a text-oriented
observation, and free-form completion criteria. It also treated repeated calls
as loops before checking whether the environment changed. The new boundaries
map those failures directly:

- guessed URLs, filenames, and expected content are filtered at compilation;
- observations and action receipts are produced by the guest/runtime;
- browser snapshots use semantic Playwright state instead of body text alone;
- facts carry origin and evidence links, so hypotheses cannot satisfy checks;
- deterministic verification evaluates exact requirements rather than model
  supplied acceptance criteria;
- progress compares meaningful state, and recovery records failed strategies;
- structured state is persisted and bounded before it is sent back to a model.

## Persistence

Migrations 3 and 4 add task/state snapshots to `runs` and orchestration fields
to `run_steps`. The compact state is durable and inspectable, while recent
actions and receipts provide an audit trail. The API continues to expose the
shared `Run` and `RunStep` shapes, so older runs without snapshots remain
readable.
