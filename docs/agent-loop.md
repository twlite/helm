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
facts. Browser reads accept a task-derived or model-supplied query and return
ranked semantic block summaries with compact previews. Full blocks remain in a
revision-bound guest registry and can be fetched through their content refs.

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
Run steps persist tool names, inputs, results, and receipts. Before context is
estimated or passed to the model, tool results receive a 24,000-character
last-resort bound, with string and array limits that preserve structured fields
such as table columns, row counts, and truncation state. Browser tools already
apply tighter retrieval limits; this context cap handles unexpected results.
Duplicate boundary snapshots are dropped. Repeated identical actions without a
concrete state change, tool failures, model steps, and tool execution time are
bounded. Cancellation is passed through to both model and guest calls.

## Progressive browser inspection

Ordinary environment reads do not fetch page text or a snapshot. They carry
only URL, title, loading state, page count, and DOM revision. The model chooses
when to request the bounded page outline, read page content, or search for
specific information. `browser.read` and `browser.search` use the same local
semantic extraction and ranker. Search returns typed blocks, current-page
content refs, and hrefs observed in the DOM. The runtime remembers those hrefs
as navigation provenance, while `browser.open({ ref })` lets the guest resolve
and open one without asking the model to retype its URL.

Tables are first-class blocks with caption, heading ancestry, columns, rows,
and span metadata where available. Query results contain a small row preview;
`browser.read({ref, offset, limit})` retrieves more rows, list items, or
`browser.read({ref, offset, maxChars})` retrieves a prose chunk. `fs.write` can accept
`sourceRef` and a deterministic text, Markdown, JSON, or CSV format, so the
guest transfers the selected full block without routing all its contents
through the model. Ordinary `content` writes remain available. A successful
current-run `fs.write` receipt is required for explicit write requests even if
the file existed before the task; an explicit open request requires a
current-run `app.openFile` receipt and the resulting desktop state.

Semantic region, element, and content refs are tied to the observed page
revision. Navigation or meaningful DOM changes expire them, and the guest
returns a stale-ref error so the model can inspect the current page again.
Extraction combines semantic DOM, HTML/ARIA tables, accessible frames, and an
ARIA snapshot fallback. Readability is used locally as an additional candidate
for prose-heavy pages. Page settling uses bounded DOM readiness and a short
content-stability check rather than waiting indefinitely for network idle.

Browser navigation accepts a user-supplied destination, an exact verified
memory URL, or a URL observed in browser results or page links. If the model
proposes an unobserved destination, the runtime starts a DuckDuckGo search
using the current task's terms. The model must select a destination from the
visible result links; URLs are not inferred from organization names.

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

The acting agent can manage persistent memory with the native `memory.search`,
`memory.remember`, `memory.update`, and `memory.forget` tools. Explicit writes
can happen after the agent discovers information during the run, with observed
facts linked to successful tool receipts. Retrieval uses the current request
and nearby user/assistant subject context. See [`memory.md`](./memory.md) for
the complete lifecycle and ranking details.

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
compatibility tests and the deterministic demo. Their previous queryless
whole-page extraction rewrites have been removed. `createAiRuntime` uses the
native acting-agent path; legacy state and verification utilities do not
influence its tool catalog or execution.

## Current limits

Native tool calls require an LM Studio model and compatibility mode that accept
OpenAI-compatible function definitions and return function calls. Helm does
not fall back to synthetic JSON tool calling. Tool output is bounded to protect
the model context, and the acting model supplies the effect list used by the
generic completion check. The runtime verifies that list against receipts; it
does not independently infer task meaning. Local lexical ranking uses the
visible page DOM and does not handle content available only after client-side
actions the model has not taken.

Behavior-focused tests live in `apps/server/tests/runtime/acting-agent.test.ts`.
