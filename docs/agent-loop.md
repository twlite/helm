# Helm agent loop

Production AI runs use one acting model conversation for chat, computer-use
decisions, tool results, recovery, and the final reply.

```text
conversation request
    -> acting model
    -> final reply

computer-use request
    -> acting model with native Helm tool definitions
    -> validated ToolRegistry execution in the guest
    -> receipt and tool result returned to the same conversation
    -> more tool calls as needed
    -> generic effect check
    -> final reply from the acting model
```

The acting model sees the original user message and recent thread messages. It
decides whether a computer tool is useful. Conversation-only turns do not call
the guest transport, so they do not start the VM, browser, or desktop. There is
no natural-language requirement compiler or browser-keyword router in the
production path.

## Native tool loop

`AiSdkActingAgent` uses the installed AI SDK `ToolLoopAgent` and LM Studio's
OpenAI-compatible chat model. It sends actual function definitions built from
the current `ToolRegistry` entries, including their descriptions and Zod
schemas. It does not serialize a tool catalog into a prompt or ask the model to
imitate calls with JSON text.

Helm runs one native model/tool step at a time. AI SDK response messages,
including assistant tool calls and tool results, are appended to the same model
conversation before the next step. This lets the runtime consume steering,
persist each action, apply budgets, and send tool errors back for recovery. The
model can use registered browser, filesystem, desktop, and application tools;
all calls still pass through `ToolRegistry.execute` and the guest RPC boundary.
There is no unrestricted host shell tool.

The prompt is intentionally short. It establishes Helm's role, says to use
actual results and not claim unverified effects, and tells the model how to
finish. It does not prescribe browser sequences, artifact formats, or domain
facts. For browser tasks, the model has bounded outline, local page search, and
region inspection tools; it can use query extraction or explicit full-page
extraction when those are needed.

## Completion and concrete evidence

The model finishes through the internal `helm.complete` tool with a user-facing
response and a list of registered tool effects required for the request. The
runtime counts successful calls for each listed tool and accepts completion
only when those calls have successful results. If an effect is missing, the
tool returns the missing names and counts in its error result; the acting model
receives that result in the same conversation and may continue. If the model
returns ordinary text without calling `helm.complete`, Helm asks that same
model to perform the completion check through a forced native call.

This check verifies execution evidence only. The model determines what the
request means, which effects are needed, what to write, and how to answer. Helm
does not generate file contents or decide whether a portfolio, report, or poem
is semantically good.

Guest calls produce action receipts with real success/failure and available
effects such as navigation, filesystem changes, downloads, and desktop state.
Run steps persist tool names, inputs, results, and receipts. Tool output sent
back to the model is bounded; it keeps useful data and the receipt while
dropping duplicate boundary snapshots. Repeated identical actions without a
concrete state change, tool failures, model steps, and tool execution time are
bounded. Cancellation is passed through to both model and guest calls.

## Progressive browser inspection

Ordinary environment reads do not fetch page text or a snapshot. They carry
only URL, title, loading state, page count, and DOM revision. The model chooses
when to request the bounded page outline, search visible regions with lexical
ranking, and inspect a matching region. Tables are returned as bounded column
and row arrays. `browser.extractText` remains available for pages whose
structure is insufficient; queryless output is small by default and a full
read requires `mode: "full"` with an explicit character limit.

Semantic region and element refs are tied to the observed DOM revision. A
navigation or meaningful DOM mutation expires them, and the guest returns a
stale-ref error so the model can inspect the current page again.

## Context budgeting and compaction

Before each model request, Helm estimates input from instructions, native tool
descriptions/schemas, and serialized retained messages. The default estimate is
one token per four characters with 12% overhead. The context window and
pressure thresholds live in `config/models.json`; deployments can override
`HELM_LLM_CONTEXT_WINDOW_TOKENS`, `HELM_LLM_CONTEXT_COMPACT_AT_RATIO`,
`HELM_LLM_CONTEXT_CRITICAL_AT_RATIO`, `HELM_LLM_CONTEXT_RECENT_EXCHANGES`, and
`HELM_LLM_CONTEXT_CRITICAL_RECENT_EXCHANGES`.

When pressure reaches the configured threshold, deterministic pruning removes
duplicate browser observations and page outlines/search results from older
revisions, while retaining their source receipts. If context is still high,
Helm uses a structured summary call for older exchanges and preserves the
current request, recent raw exchanges, verified receipt IDs, actual artifacts,
the latest browser URL/revision, focused desktop window, and unresolved work.
The model summary is lossy working context, not evidence: each carried finding
or completed action must cite a receipt ID that was previously validated.
Obsolete browser refs are removed. The call happens only at a context-pressure
boundary, and persisted compaction events expose what was kept and pruned in the
run activity UI.

This summary is local to one run. The separate persistent memory system stores
selected information for later runs; recalled memory is a hint that may need
live verification, never current external evidence.

## Ownership

- The model owns semantic reasoning, choosing whether and how to use tools,
  creating artifact content, recovering from tool errors, and writing the final
  user-facing response.
- The runtime owns tool schemas, sandbox enforcement, guest execution, action
  receipts, persistence, cancellation, budgets, loop protection, and checks
  that claimed tool effects have successful results.
- The guest owns filesystem, Playwright browser, and desktop operations inside
  the isolated VM.

The older planner, orchestrator, and worker interfaces remain for scripted
compatibility tests and the deterministic demo. `createAiRuntime` does not
instantiate them. Legacy state and verification utilities are not on the
production AI execution path.

## Current limits

Native tool calls require an LM Studio model and compatibility mode that accept
OpenAI-compatible function definitions and return function calls. Helm does
not fall back to synthetic JSON tool calling. Tool output is bounded to protect
the model context, and the acting model supplies the effect list used by the
generic completion check. The runtime verifies that list against receipts; it
does not independently infer task meaning.

Behavior-focused tests live in `apps/server/tests/runtime/acting-agent.test.ts`.
