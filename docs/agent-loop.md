# Helm agent loop

Production runs use one acting model conversation for ordinary chat,
computer-use decisions, tool results, recovery, and the final reply.

```text
user request
    -> model with all registered Helm tools
    -> model-selected tool call
    -> ToolRegistry schema and operation validation
    -> guest RPC or memory tool
    -> actual result and receipt return to the same conversation
    -> more model-selected actions as needed
    -> model proposes a final answer
    -> runtime verifies explicitly requested end effects
    -> answer is accepted or missing effects return to the model
```

The deterministic compiler extracts a small set of concrete end effects when
the request states them clearly, such as visiting an explicit URL, writing a
named file, opening a file in an application, or mutating persistent memory.
It does not compile a browser/search/read/write/open plan. The original user
request and conversation remain available to the acting model. Requests that
do not require computer actions can be answered normally without starting the
guest environment.

## Native tool loop

`AiSdkActingAgent` uses the AI SDK `ToolLoopAgent` and the configured
OpenAI-compatible model. It sends native tool definitions, descriptions, and
Zod schemas from the `ToolRegistry`, with `toolChoice: "auto"`. The acting
model normally sees every tool registered for the computer-use runtime:
browser navigation, web search, semantic reading, DOM query and evaluation,
filesystem operations, applications, desktop controls, and memory tools.

Helm advances one model step at a time so it can persist actions, accept
steering, and enforce its budgets. That does not narrow the model's tool list
or choose its next action. Tools validate their own inputs and real operating
conditions. For example, `app.openFile` returns `FILE_NOT_FOUND` for a missing
file; the result goes back to the model so it can recover.

The runtime retains VM isolation, guest RPC, Zod validation, the filesystem
sandbox, Playwright, application launching, action receipts, run persistence,
activity events, cancellation, timeouts, action and model-turn budgets, basic
identical-action detection, and context compaction. There is no host shell tool.

## Completion and concrete evidence

Final assistant text is a completion proposal. The runtime checks explicitly
requested end effects against successful current-run receipts. It does not
check the intermediate sequence used to reach them or keep a second workflow
state that can contradict a receipt.

- A requested file write needs a successful `fs.write` receipt for the
  normalized requested path. If the request requires non-empty output, the
  receipt must record bytes written. Page-derived file requests also require
  successful browser evidence.
- A requested file open needs a successful `app.openFile` receipt for the
  normalized requested path and application. A failed `FILE_NOT_FOUND` result
  cannot satisfy it.
- An explicit browser destination needs successful navigation evidence for
  the requested destination or its legitimate redirect, recorded in the
  navigation receipt.
- A requested memory change needs a successful memory-operation receipt whose
  effect records a mutation.

The model owns semantic work such as summarizing a page, deciding which data
matters, and writing artifact content. Verification confirms that page
evidence was gathered when needed and that requested external effects
happened. It does not try to decide whether the summary is correct or whether
the artifact is well written.

If final verification finds a missing effect, Helm adds a concise message to
the same conversation describing what remains and lets the model continue with
the full tool set. It does not prescribe the next action. A run ends only
after verification succeeds or a hard budget, cancellation, or execution
failure ends it.

Guest tools produce receipts with actual success or failure and available
effects such as navigation, filesystem changes, downloads, and desktop state.
Run steps persist the model-proposed input and the input sent to the tool.
Diagnostics track model turns, requests, tool actions, completion attempts,
context compactions, and unsatisfied end effects. Each model request also
records whether it produced text, tool calls, an empty response, an accepted or
rejected completion, schema errors, execution failures, or a pre-execution
rejection, along with provider-call and retry counts. An empty response ends
with a diagnostic error instead of silently repeating the same request.
Tool results receive a 24,000-character last-resort context bound while
retaining useful structured fields. Browser retrieval applies tighter limits
first. The default acting run allows 32 tool actions, 12 model turns, and two
completion-recovery turns; configuration can lower or raise these bounds.
Cancellation reaches both model and guest calls.

## Browser references and inspection

Helm distinguishes three browser reference types:

- **Element refs** point to live DOM elements used by click, type, and similar
  interactions. They are bound to the current page revision and may become
  stale after navigation or a DOM change.
- **Navigation refs** point to HTTP or HTTPS hrefs that Helm actually
  observed. They survive unrelated DOM revisions and can be passed to
  `browser.open`.
- **Content refs** point to immutable snapshots of extracted semantic blocks.
  The guest stores the normalized block, source URL, title, revision, and
  capture time in a bounded in-memory store. Ordinary DOM mutations and later
  navigation do not invalidate the snapshot; it remains available until the
  store evicts it or the browser session resets.

`browser.read` returns compact typed summaries and durable content refs. The
model can inspect additional table rows, list items, or text chunks with
`browser.read({ ref, offset, limit })`. It may pass a returned content ref
directly to `fs.write({ sourceRef, format })`; another `browser.read({ ref })`
is not required first. The guest serializes the full stored snapshot as text,
Markdown, JSON, or CSV. Normal model-authored content can be written through
`fs.write({ content })`.

The reported table `rowCount` describes content extracted from the page's
current DOM. It may represent only rows rendered so far. If that looks
incomplete, the model can inspect the bounded DOM with `browser.query` or use
`browser.evaluate` to read JSON-serializable data after the page renders more
rows. The model decides whether to wait, inspect controls, or use another
available browser action.

Semantic extraction is the compact default. When it cannot expose the needed
page information, `browser.query` can inspect a bounded set of DOM elements by
CSS selector, text, role, or accessible name. It returns compact metadata and
live element refs, plus navigation refs for observed links. `browser.evaluate`
is a lower-level fallback that runs a JavaScript expression only inside the
current browser page. It returns JSON-serializable data under a response size
limit and a tool timeout; it has no guest filesystem, process, environment, or
host API access. Neither tool dumps unlimited HTML.

`browser.snapshot` provides a bounded semantic outline and visible controls.
`browser.findPage` ranks content on the current page only; `browser.webSearch`
performs DuckDuckGo discovery. The model may search again if results are poor.
When the user supplies an HTTP or HTTPS destination, the model can navigate
there directly. Helm does not force discovery through a search engine or
invent an unknown website.

## Context and memory

Before each model request, Helm estimates input size from instructions, native
tool schemas, and retained messages. At configured pressure thresholds it
prunes duplicate observations and, when needed, summarizes older exchanges
while preserving the current request, recent tool results, receipt-backed
effects, artifacts, and current environment state. A summary is working
context, never new evidence. Obsolete live element refs are removed; immutable
content snapshots remain valid in the guest store for their bounded lifetime.

Persistent memory is separate from run-local context compaction. The acting
agent can use native `memory.search`, `memory.remember`, `memory.update`, and
`memory.forget` tools. Memory changes receive receipts; recalled memory is
reference material, not proof of current external state. See
[`memory.md`](./memory.md) for its lifecycle.

`app.launch` starts an allowlisted application when the user asks to launch it
without a file. `app.openFile` checks that the requested path is a regular file
before producing application side effects, then starts the selected
application with that file when needed. For a file-open request, the model can
call `app.openFile` directly; it does not need to launch the app first.

## Ownership

- The model owns semantic reasoning, action sequencing, recovery, artifact
  content, and the final user-facing response.
- Tools own validation of their input and the real operation they perform.
- The runtime owns isolation boundaries, budgets, persistence, receipts,
  cancellation, loop protection, and verification of requested end effects.
- The guest owns filesystem, Playwright browser, and desktop operations inside
  the isolated VM.

The older planner/orchestrator/worker loop remains available to legacy tests
and demos. Production server runs use the model-led acting-agent path above.

## Current limits

Native tool calls require a model server that accepts OpenAI-compatible
function definitions and returns function calls. Helm does not fall back to
synthetic JSON tool calling. Browser evaluation is limited to page context,
time, and response size. Semantic ranking sees the current DOM and cannot
retrieve content hidden behind interactions the model has not taken.

Outcome-focused tests live in `apps/server/tests/runtime/acting-agent.test.ts`
and the guest browser tests.
