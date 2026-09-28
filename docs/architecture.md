# Helm architecture

Helm is a local computer-use assistant. The production agent loop keeps the
acting model in control of action sequencing and keeps execution safety in the
runtime and individual tools.

```text
browser UI -- REST + WebSocket --> Bun server
                                   |- acting model + all relevant Helm tools
                                   |- end-effect compiler and verifier
                                   |- ToolRegistry -> validated guest RPC
                                   |- action receipts + run persistence
                                   `- VmController -> typed guest transport
                                                        | JSON Lines
                                                        v
                                             Swift VM host -> helm-guest
                                                              |- Playwright
                                                              `- desktop/filesystem
```

## Responsibilities

- `packages/shared` owns protocol schemas and persisted conversation/run types.
- `apps/server/src/ai/acting-agent.ts` sends native tool definitions to the
  configured model, keeps one coherent conversation, and returns tool results
  to that same conversation.
- `apps/server/src/agent/runtime.ts` owns cancellation, tool and model budgets,
  persistence, action-loop protection, receipts, and end-effect verification.
- `apps/server/src/tools` owns Zod input validation, guest calls, and action
  receipt generation.
- `apps/server/src/memory` owns persistent memory, its native acting-agent
  tools, contextual retrieval, and conservative post-run extraction.
- `apps/server/src/db` persists messages and run-step activity.
- `guest/helm-guest` performs sandboxed filesystem, visible-browser, and
  desktop operations.
- `apps/web` renders persisted and live messages, runs, and activity. It does
  not infer completion from UI state.

Production compiles only concrete end effects that can be checked from
receipts and environment state. It does not compile an action plan or a graph
of browser/search/read/write/open prerequisites. The original request and
recent conversation go to the acting model unchanged. The model chooses
whether tools are needed, which registered tools to call, and in what order.

## Model and runtime boundary

Production acting turns use native function tools with `toolChoice: "auto"`.
The runtime supplies the full registered tool set appropriate to the current
computer-use runtime; it does not narrow that set based on pending
requirements. A tool call goes through `ToolRegistry`, Zod validation, and the
existing guest RPC or memory tool. Successful and failed results, including
receipts, return to the same model context. A tool validates its real
preconditions. For example, opening a missing file returns `FILE_NOT_FOUND`,
and the model can respond to that result.

The model owns semantic reasoning, action sequencing, recovery, and semantic
artifact content. The runtime does not replace model-generated HTML,
documents, reports, or other artifacts with content assembled from internal
facts. When the model proposes a final response, the runtime verifies
explicitly requested end effects such as a current-run write to a particular
path, a file open in the requested application, a visit to an explicit
destination, or a memory change. It does not verify the intermediate workflow
or try to determine semantic correctness of a summary.

Successful current-run receipts are the authority for concrete tool effects.
A requested write needs a successful `fs.write` receipt for the normalized
path, plus a positive byte count when non-empty output was requested. A
requested open needs a successful `app.openFile` receipt for the normalized
path and application; a failed `FILE_NOT_FOUND` result does not pass. An
explicit destination needs the navigation receipt's requested and final URL,
including a legitimate redirect. A memory mutation needs its successful
operation receipt and mutation effect. Page-derived requests also need
successful browser evidence. A failed effect produces concise missing-effect
feedback in the same conversation, with the full tool set still available.
VM isolation, sandboxing, tool schemas, receipts, activity events,
persistence, cancellation, timeouts, action budgets, model-turn budgets,
basic repeated-action detection, and context compaction remain in place.

The older model planner, orchestrator, and worker path remains available to
legacy tests and demos. Production server runs use the model-led acting-agent
path.

## Browser perception and references

Normal environment observations include browser URL, title, loading state,
page count, and DOM revision. The model requests page detail when useful:

```text
browser.snapshot / browser.read / browser.findPage / browser.query / browser.evaluate
```

`browser.read` and `browser.findPage` use structured semantic extraction for
tables, headings, prose, lists, code, forms, navigation, search results, and
other useful content. `browser.findPage` searches the current page only;
`browser.webSearch` performs DuckDuckGo discovery. The model may refine a
search by calling `browser.webSearch` again. It may directly navigate to a
user-provided HTTP or HTTPS destination. Helm does not rewrite navigation
into a search or prescribe a search/read/open order.

Browser refs have different lifetimes and contracts:

- **Element refs** identify live DOM elements for interactive operations such
  as click and type. They are bound to the current DOM revision and can become
  stale after page changes.
- **Navigation refs** identify HTTP or HTTPS hrefs that Helm actually
  observed. They survive unrelated DOM revisions and are resolved by
  `browser.open`.
- **Content refs** identify immutable normalized snapshots extracted from a
  page. The guest retains each block with its source URL, title, source
  revision, capture time, and serialized size in a bounded in-memory store.
  Ordinary DOM mutations and later navigation do not invalidate these
  snapshots. They expire through bounded-store eviction or a browser-session
  reset, not through page revision checks.

`browser.read` returns compact summaries with content refs. The model may use a
content ref directly in `fs.write({ sourceRef, format })`; another
`browser.read({ ref })` is not needed just to select it. The model can use
`browser.read({ ref, offset, limit })` for deeper inspection or pagination.
`fs.write` serializes the stored snapshot locally as text, Markdown, JSON, or
CSV, and it also accepts model-authored content.

Semantic table row counts describe the rows extracted from the current page
DOM, which may be only the rows rendered so far. The model can use bounded
`browser.query` or page-context `browser.evaluate` to inspect additional
rendered or dynamically loaded rows without receiving unlimited HTML.

When semantic extraction is insufficient, `browser.query` inspects a bounded
set of DOM elements by CSS selector, text, role, or accessible name. It
returns compact tag, role, text, and attribute data, along with live element
refs and observed-link navigation refs. `browser.evaluate` runs a JavaScript
expression only in the current page context. It has a bounded timeout and
JSON response size, accepts JSON-serializable results, and receives no guest
filesystem, process, environment, or host APIs. Neither tool returns unlimited
HTML.

## Receipts, persistence, and budgets

Each actual tool call records its input, result, timestamps, and receipt.
Filesystem, browser, application, desktop, and memory effects remain visible
to run-state verification and activity events. `runs.task_json`, `state_json`,
and `diagnostics_json` retain compiled effects, run state, and execution
counts. Per-model-request outcomes include whether the model returned text,
called tools, proposed a rejected completion, failed tool validation, hit a
pre-execution rejection, or returned no actionable output, along with provider
call and retry counts. The acting loop stops on empty output instead of
silently spending more turns with the same context. `run_steps` retains the
model proposal, effective tool input, result, and verification. UI state is
not completion evidence.

Tool calls, model turns, repeated no-progress actions, operation timeouts, and
cancellation are bounded. Run activity exposes progress and context usage
without replacing actual tool results. Context compaction preserves the
current user request, recent tool conversation, actual receipts and artifacts,
and environment state. A generated context summary is working context, never
new evidence. The acting agent's persistent memory tools remain part of the
same native tool set.

## Browser execution

The guest uses Playwright inside the isolated VM. Semantic extraction keeps
page content compact, while `browser.query` and `browser.evaluate` provide
bounded inspection fallbacks. Raw DOM element refs remain live, revision-bound
handles. Navigation refs preserve exact observed hrefs. Content refs preserve
copied extracted data independently of the live page. `app.openFile` checks
the real sandbox filesystem before application side effects and returns
`FILE_NOT_FOUND` when the file is missing. It starts the selected application
with an existing file when needed. `app.launch` is for explicit application
launches without a file, not a preparation step for `app.openFile`.
