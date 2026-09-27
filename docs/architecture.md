# Helm architecture

Helm is a local computer-use assistant with a single acting model conversation
and a guarded execution runtime.

```text
browser UI -- REST + WebSocket --> Bun server
                                   |- acting model + native Helm tools
                                   |- deterministic task compiler + requirement state
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
  passes native function definitions to the configured LM Studio model,
  budgets the retained conversation, and returns AI SDK tool results to the
  same conversation.
- `apps/server/src/agent/runtime.ts` owns cancellation, separate model/action
  budgets, persistence, action-loop protection, current-run receipts,
  dependency enforcement, and requirement verification.
- `apps/server/src/tools` owns Zod input validation, guest calls, and action
  receipt generation.
- `apps/server/src/memory` owns persistent memory, its native acting-agent
  tools, contextual retrieval, and conservative post-run extraction.
- `apps/server/src/db` persists messages and run-step activity.
- `guest/helm-guest` performs sandboxed filesystem, visible-browser, and
  desktop operations.
- `apps/web` renders persisted and live messages, runs, and activity. It does
  not infer completion from UI state.

Production AI turns compile each request into a `TaskDefinition` before the
acting model runs. `DeterministicTaskCompiler` derives concrete effects,
requested paths and URLs, current-run action semantics, and a small dependency
graph without a planning-model request. It does not generate an action plan or
artifact content. The complete original request and recent conversation still
go to the acting model. Production does not use the model-backed planner,
orchestrator, bounded worker, or a separate response-generation model.
Scripted compatibility tests and the deterministic demo may still use legacy
interfaces.

## Model and runtime boundary

The model decides what the user means, whether tools are needed, which actions
to take, how to recover, and what semantic content to create. It may return an
ordinary answer without invoking a computer tool.

When it calls a tool, the runtime validates the input with the registered
schema and executes through the existing guest boundary. Actual results,
including failures and action receipts, return to the same model conversation.
The runtime does not replace model-generated HTML, documents, reports, or
other artifacts with content of its own.

Ordinary assistant text is a completion proposal. The runtime checks it using
the compiled task and current-run `TaskState`: exact action receipts, matching
paths and URLs, source refs, artifact lineage, and dependencies. Missing
effects produce concise feedback in the same model conversation. The model
cannot redefine required effects in its response. A `helm.blocked` report is
accepted only when a relevant failed action receipt supports the pending
requirement. This check does not decide what fields belong in an artifact or
whether the response is semantically complete.

When a task saves page-derived content, its output-file requirement depends on
a successful readable browser result. A zero-match search is query-local: it
proves neither that the page is unreadable nor that its content was read.
Explicit output actions are verified from a successful current-run write
receipt for the requested path. Existing files cannot satisfy a new write
action, while `sourceRef` writes preserve source URL, revision, and content
lineage. Explicit file opens depend on their current-run write and require a
matching `app.openFile` receipt even if the file or editor window existed
before the run.

## Persistence and limits

`runs.task_json`, `state_json`, and `diagnostics_json` store the compiled
requirements, current state, and execution counts. `run_steps` stores each
validated tool invocation, its effective input, the model proposal, result,
and verification. The activity UI shows effective navigation alongside the
model-proposed destination. It also displays compact requirement and budget
state. Live events can be reconciled with durable run status and steps after
reconnecting.

Tool calls, model steps, consecutive tool errors, repeated no-progress actions,
timeouts, and cancellation are bounded. Guest tools retain filesystem
sandboxing, browser automation, desktop operations, and receipt evidence.

## Browser perception

Normal environment observations include only browser URL, title, loading state,
page count, and DOM revision. They do not request or attach a semantic page
snapshot. The acting model can request progressive detail when it needs it:

```text
browser.getState -> browser.snapshot -> browser.read / browser.search -> browser.inspectRegion
```

`browser.snapshot` returns a bounded DOM outline and visible controls with
legacy `r...` region refs for inspection and interaction. Information
retrieval uses the semantic extractor: `browser.read` and `browser.search`
extract and rank the same typed blocks for tables, headings, prose, lists,
code, forms, navigation, search results, and other useful content. Search
returns compact typed summaries, including observed hrefs, stable `c...`
content refs, relevance, match count, and whether semantic content was
extracted. Local ranking uses field boosts for headings, table headers, form
labels, titles, snippets, and hrefs.

Full extracted blocks live in a guest content registry. A `c...` ref can fetch
a block or paginate table rows with `browser.read`; navigation or page
mutations expire refs. `browser.open({ ref })` resolves a destination from a
current block's observed href inside the guest, so the model does not retype
URLs. DuckDuckGo redirect parameters are unwrapped locally. `fs.write` accepts
either normal string content or a content `sourceRef` and serializes the
selected full block locally as text, Markdown, JSON, or CSV. Tables preserve
heading ancestry, complete rows, and row/column spans where available. The
source-ref write result reports source URL, revision, and type with filesystem
evidence.

`browser.inspectRegion` reads one selected region as bounded text, local links,
or structured table columns and rows. Text inspection defaults to 8,000
characters. Table inspection defaults to 50 rows and supports `offset` and
`limit` pagination; it reports total and returned row counts and truncation.
Search and inspection results are persisted in normal tool receipts and shown
in the run activity feed.

Region and interactive refs encode the current DOM revision. Navigation and
observed DOM changes invalidate earlier refs; the guest rejects expired refs
instead of acting on a control from an older page state. Reads settle on
bounded DOM readiness and content stability, inspect accessible frames and
open shadow roots, and combine semantic DOM, table/grid, optional local
Readability, and ARIA fallback signals. Raw HTML and the complete DOM stay out
of model context.

Navigation policy records whether a destination came from the user,
verified-memory, a DuckDuckGo result, a page link, or a navigation result. A
model-proposed URL without that provenance starts a DuckDuckGo search using
the current request; the runtime does not turn site or organization names into
guessed routes. Once a search result or page link has a semantic ref, opening
it should use `browser.open({ ref })`. Exact relevant verified-memory URLs are
allowed directly and are removed from the temporary capability if they fail
or redirect unexpectedly.

## Model context management

The acting agent estimates input use from its instructions, registered tool
definitions, and serialized retained messages. The current estimate is roughly
one token per four characters plus 12% overhead; it is an estimate, not a
provider tokenizer. The configured context window is in `config/models.json` or
can be overridden with `HELM_LLM_CONTEXT_WINDOW_TOKENS`. The model config also
sets compaction and critical-pressure ratios and how many recent exchanges to
keep raw.

Before context estimation, the context manager bounds tool results to 24,000
characters, caps oversized strings and arrays, and preserves useful structure
such as table columns, row counts, and truncation state. This is a final safety
net after browser-specific retrieval limits.

At the configured pressure threshold, Helm first prunes duplicate browser
observations and snapshots/search results from older DOM revisions. At higher
pressure it keeps the current request, recent raw exchanges, and current
operational state, then replaces older exchanges with a structured continuity
summary. A structured model call is made only at that boundary, not after each
tool result. The summary can retain findings and completed work only when they
cite receipt IDs already present in tool evidence. Artifacts and the latest
browser/desktop state are reconstructed from observed results. Summary text is
never promoted to a receipt or trusted evidence, and stale DOM refs are removed
from compacted context.

`run.context.usage` reports estimates to the activity UI. A completed
compaction is persisted with its pressure reason, before/after estimates,
pruning counts, kept raw exchanges, and preserved/removed state. This is
run-local continuity. Persistent memory is retrieved separately as a hint for
future runs and is not treated as proof that an external fact remains current.

## Persistent memory

Persistent memory has an independent lifecycle from message history and
run-local context compaction. The acting agent can search, remember, update, and
forget memories through validated host tools in the same native tool loop.
Observed memories retain source URLs and successful action receipt IDs. Memory
retrieval combines full-text and optional vector results; the detailed lifecycle,
ranking, provenance, UI, and migration behavior is documented in
[`memory.md`](./memory.md).
