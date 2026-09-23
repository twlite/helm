# Helm architecture

Helm is a local computer-use assistant with a single acting model conversation
and a guarded execution runtime.

```text
browser UI -- REST + WebSocket --> Bun server
                                   |- acting model + native Helm tools
                                   |- ToolRegistry -> validated guest RPC
                                   |- action receipts + effect verification
                                   |- repositories -> better-sqlite3
                                   `- VmController -> typed guest transport
                                                        | JSON Lines
                                                        v
                                             Swift VM host -> helm-guest
                                                              |- Playwright
                                                              `- desktop/filesystem
```

## Responsibilities

- `packages/shared` owns protocol schemas and persisted conversation/run types.
- `apps/server/src/ai/acting-agent.ts` owns the AI SDK tool-loop adapter. It
  passes native function definitions to the configured LM Studio model and
  returns AI SDK tool results to the same conversation.
- `apps/server/src/agent/runtime.ts` owns cancellation, budgets, persistence,
  action-loop protection, receipts, and generic completion checks.
- `apps/server/src/tools` owns Zod input validation, guest calls, and action
  receipt generation.
- `apps/server/src/db` persists messages and run-step activity.
- `guest/helm-guest` performs sandboxed filesystem, visible-browser, and
  desktop operations.
- `apps/web` renders persisted and live messages, runs, and activity. It does
  not infer completion from UI state.

Production AI turns do not use a task compiler, orchestrator, bounded worker,
or second response-generation model call. The runtime stores a minimal request
envelope for the run; the complete user request and recent conversation go to
the acting model. Scripted compatibility tests and the deterministic demo may
still use the legacy interfaces.

## Model and runtime boundary

The model decides what the user means, whether tools are needed, which actions
to take, how to recover, and what semantic content to create. It may return an
ordinary answer without invoking a computer tool.

When it calls a tool, the runtime validates the input with the registered
schema and executes through the existing guest boundary. Actual results,
including failures and action receipts, return to the same model conversation.
The runtime does not replace model-generated HTML, documents, reports, or
other artifacts with content of its own.

Before Helm accepts the final answer, the model lists the concrete registered
tool effects needed for its response through the internal completion tool. The
runtime checks successful call counts against real results. A missing effect
becomes a tool error in the same conversation, giving the acting model a chance
to finish the work or report a blocker. This check does not decide what fields
belong in an artifact or whether the response is semantically complete.

## Persistence and limits

`runs.task_json` stores the request envelope. `run_steps` stores each validated
tool invocation, its input and result, plus completion verification. The UI
continues to receive live events and can reconcile durable run status and
steps after reconnecting.

Tool calls, model steps, consecutive tool errors, repeated no-progress actions,
timeouts, and cancellation are bounded. Guest tools retain filesystem
sandboxing, browser automation, desktop operations, and receipt evidence.
