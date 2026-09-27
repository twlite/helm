# Helm agent loop

Production AI runs use one acting model conversation for chat, computer-use
decisions, tool results, recovery, and the final reply.

```text
user request
    -> deterministic TaskDefinition compiler
    -> acting model
    -> runtime verifies final reply
    -> final reply

computer-use request
    -> acting model with native Helm tool definitions
    -> validated ToolRegistry execution in the guest
    -> receipt and tool result returned to the same conversation
    -> more tool calls as needed
    -> runtime verifies TaskDefinition against current-run receipts
    -> final reply from the acting model
```

The acting model sees the original user message, recent thread messages, the
compiled task, and a compact current requirement summary. The deterministic
compiler creates concrete effect requirements from explicit user requests,
paths, URLs, and action verbs without a planning-model call. It does not make
semantic choices about what a report or other artifact should contain. A
conversation task has no computer requirements and does not call the guest
transport, so it does not start the VM, browser, or desktop.

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

The prompt is intentionally compact. It establishes Helm's role, says to use
actual results and not claim unverified effects, and includes the current
requirement states. Dependencies are shown as blocked until their prerequisites
are satisfied. Browser reads accept a task-derived or model-supplied query and
return ranked semantic block summaries with compact previews. Full blocks
remain in a revision-bound guest registry and can be fetched through their
content refs.

## Completion and concrete evidence

Ordinary assistant text is a completion proposal. The runtime checks it against
the compiled `TaskDefinition`, `TaskState`, exact action receipts, artifacts,
and dependency graph. For example, a current-run write to `other.txt` cannot
satisfy a requirement to write `forex.txt`, and an old file or editor window
cannot satisfy a request to write or open it during this run. A dependent
`app.openFile` call is rejected with `TASK_PREREQUISITE_NOT_SATISFIED` until
the matching `fs.write` receipt exists. When a proposal is incomplete, the
runtime returns concise missing-requirement feedback in the same conversation.

The model does not author a required-effects list. The model determines the
meaning of the request, chooses actions, creates artifact content, and writes
the answer. The runtime decides whether actions satisfy requirements and does
not decide whether a report, portfolio, or poem is semantically good. A
`helm.blocked` report is accepted only when a relevant failed action receipt
supports the pending requirement.

Guest calls produce action receipts with real success/failure and available
effects such as navigation, filesystem changes, downloads, and desktop state.
Host-side memory mutations also receive current-run receipts. Run steps persist
the model-proposed input separately from the effective input sent to a tool.
Run diagnostics persist model turns, total model requests, tool actions,
completion attempts and rejections, context compactions, and the last
unsatisfied requirements. Before context is
estimated or passed to the model, tool results receive a 24,000-character
last-resort bound, with string and array limits that preserve structured fields
such as table columns, row counts, and truncation state. Browser tools already
apply tighter retrieval limits; this context cap handles unexpected results.
Duplicate boundary snapshots are dropped. Tool actions and model turns use
separate budgets: the default acting run allows 32 tool actions, 12 model
turns, and at most two completion-recovery turns. Repeated identical actions
without a concrete state change, tool failures, and tool execution time are
also bounded. `HELM_MAX_STEPS`, `HELM_MAX_MODEL_TURNS`, and
`HELM_MAX_COMPLETION_RECOVERY_TURNS` configure those independent limits.
Cancellation is passed through to both model and guest calls.

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
memory URL, or a DuckDuckGo search URL. An unobserved proposal is rewritten to
a DuckDuckGo search using the current request. After results expose semantic
refs, the model should use `browser.open({ ref })`; raw navigation to an
observed result is rejected so the guest resolves the original observed href.
The activity record keeps the proposed URL and the effective executed URL
separate.

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

The older model-backed planner, orchestrator, worker, and legacy decision
interfaces remain for scripted compatibility tests and the deterministic
demo. Production uses the deterministic compiler and the coherent acting-model
conversation, while sharing `TaskDefinition`, `TaskState`, action receipts,
and `verifyTaskState` with the requirements-first path. Those legacy loops
still duplicate some action and recovery plumbing and can be consolidated in a
later change.

## Current limits

Native tool calls require an LM Studio model and compatibility mode that accept
OpenAI-compatible function definitions and return function calls. Helm does
not fall back to synthetic JSON tool calling. Tool output is bounded to protect
the model context. The deterministic compiler covers concrete action effects;
the model retains semantic decisions. Local lexical ranking uses the visible
page DOM and does not handle content available only after client-side actions
the model has not taken.

Behavior-focused tests live in `apps/server/tests/runtime/acting-agent.test.ts`.
