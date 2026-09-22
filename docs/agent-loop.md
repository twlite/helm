# Helm agent loop

Helm runs computer-use tasks through a requirements-first state machine. The
model proposes work, but it never owns environment state, verification, or
global completion.

```text
user request -> task compiler -> requirements + constraints
       -> orchestrator -> one bounded worker objective
       -> typed guest tools -> action receipt + environment observation
       -> evidence/fact store + task state update
       -> deterministic verification -> repeat or complete
```

The implementation lives primarily in `apps/server/src/agent/runtime.ts`,
`task-state.ts`, and `orchestrator.ts`. The older one-action provider loop is
kept as a compatibility path for scripted/demo callers that do not supply an
orchestrator and worker. AI runs created by the server use the new path.

## 1. Task compilation

`AiSdkTaskPlanner` is the task compiler. It retains the original user request
in `TaskDefinition.originalRequest` and adds compiler-owned `requirements` and
`constraints`.

Requirements describe outcomes, not a guessed sequence of clicks. For example,
a request to inspect a repository release and write a file produces fact
requirements for the repository name, release version, release date, release
URL, and current date, plus filesystem requirements for the requested Desktop
directory and a file whose content is linked to those facts. Natural-language
Desktop folder/file names are compiled into guest-sandbox paths; they are not
left for the model to invent.
Concrete URLs, filenames, and expected text are retained only when they are
explicit in the user request or are subsequently observed.

Model-produced legacy criteria are filtered against the original request before
they can be used. This prevents a model-generated `file.contains` value or
`browser.url` from becoming a hidden acceptance condition. The compiler also
adds constraints that unknown values remain unknown until a tool observes them.

## 2. Orchestrator and bounded workers

The orchestrator receives a compact copy of the current task state:

- original request, requirements, and constraints;
- trusted facts and recent evidence;
- current semantic browser/desktop environment;
- completed and unmet requirements;
- recent actions, failed strategies, blockers, and progress state.

It selects one `WorkerObjective` at a time. `AiSdkOrchestrator` may select an
unmet compiled requirement, but the runtime constructs the objective from that
requirement. If the model fails or names an unknown requirement, the
deterministic fallback chooses the next unmet requirement.

Workers have a bounded action budget (`maxWorkerActions`, eight by default).
They return `WorkerResult` values containing status, actions, facts, evidence,
artifacts, blockers, and a suggested next information field. `done` means only
that the worker is handing its objective back to the orchestrator; there is no
worker action for completing the entire task.

Worker permissions are narrow:

- browser workers can use `browser.*`;
- filesystem workers can use `fs.*`;
- desktop workers can use `desktop.*` and `app.*`;
- system workers can use the explicitly registered guest tools.

The runtime rejects a tool outside the objective's permission set.

## 3. Browser perception

`browser.snapshot` is the primary browser perception tool. The Playwright
guest returns a bounded semantic snapshot containing the URL, title, page
count, main heading/text, and visible interactive elements. Elements include
roles, accessible names, labels, values, enabled state, links, checked state,
selected state, and stable refs such as `e17` for the next action.

`browser.extractText` remains available for reading long or fallback content,
but it is not the universal observation primitive. Runtime observations request
both browser state and a semantic snapshot, so repeated calls can be compared
by meaningful page state.

DuckDuckGo is the only search engine allowed by the agent loop. Search tasks
start at a DuckDuckGo URL, and a model-proposed Google or Bing search URL is
normalized to DuckDuckGo before browser execution. Direct non-search URLs are
preserved for ordinary source sites, so named official sources can still be
opened directly. A research worker must inspect the results page and then read
the selected source page; opening a search URL alone does not satisfy the
research requirement.

## 4. Action receipts and evidence

The host-side guest tool wrapper records an `ActionReceipt` for every guest
call. Receipts include success/failure, timestamps, and effects such as:

- URL before/after, navigation, new-tab, and DOM-fingerprint changes;
- filesystem path, existence before/after, bytes, and SHA-256 for writes;
- download started, source URL, final URL, suggested filename, saved path,
  size, and browser context.

Downloads use Playwright's real `download` event when running in the guest. The
mock transport models the same record, including redirects, for tests.

The runtime stores receipts and observations as evidence. A fact is labeled
`user`, `observed`, `derived`, or `hypothesis`. Worker-proposed facts are
accepted as observed only when their receipt evidence contains the value. A
hypothesis cannot overwrite a user-provided or observed fact and cannot satisfy
a mandatory fact requirement.

## 5. Verification and completion

`verifyTaskState` is deterministic wherever the guest can answer mechanically:

- fact requirements require a trusted fact with linked evidence;
- file and directory requirements use `fs.stat` after `fs.mkdir`/`fs.write` actions;
- fact-backed file contents are read and compared to actual trusted fact values;
- explicit text requirements compare the exact user-provided text;
- downloads require a recorded artifact and saved file;
- browser requirements compare the observed URL;
- desktop requirements inspect observed windows.

Legacy criteria are still checked by `CriterionVerifierRegistry`, but they are
only accepted when they came from explicit user input or a compatibility task.
Semantic requirements remain pending until an explicit verifier is available.

The orchestrator may propose `complete`. The runtime always verifies the
current state first and rejects the proposal while any mandatory requirement or
criterion is incomplete. The run reaches `completed` only after all mandatory
requirements pass. This prevents a successful navigation or a worker's
optimistic `done` result from ending the task early.

An orchestrator response such as “cannot proceed until the browser research
requirement is complete” is treated as procedural guidance when it references
an unmet actionable requirement. Helm records that response for diagnostics and
continues with the deterministic fallback objective. Missing user input,
permission, safety, and policy blockers remain terminal.

## 6. Progress and recovery

Loop detection uses a meaningful progress fingerprint rather than a repeated
tool-name counter. The fingerprint includes the semantic browser state, desktop
windows, completed requirement IDs, trusted fact values, artifact paths and
hashes, and the current objective.

The same tool is allowed to run again when the environment changes. Different
tools still count as no progress when the relevant state remains the same.
After the configured no-progress threshold, the runtime records the
objective/action signature as a failed strategy and activates recovery. The
orchestrator receives that strategy and must choose a different approach. A
bounded recovery budget produces a useful `RECOVERY_BUDGET_EXHAUSTED` blocker;
it does not report the misleading legacy `TOOL_LOOP_DETECTED` error.

## 7. Persistence and observability

`runs.task_json` and `runs.state_json` persist the compiled task and compact
current state. Run steps persist the orchestrator decision, objective, worker,
worker result, progress, observation, and verification. Raw action results are
retained for audit/debugging, while model prompts receive only bounded slices
of structured state rather than an ever-growing transcript.

The activity feed displays objectives, worker names, worker actions, proposed
facts, progress, requirements, and deterministic verification. It labels a
completion proposal as a verification proposal rather than showing repeated
misleading “Complete task” actions.

## Benchmark shape

The integration benchmark is intentionally generic in the implementation:

```text
open a named project page
discover a release fact and the URL from observed browser evidence
create an output file
write observed facts and the runtime date
verify the file and its contents
```

The tests use a deterministic mock page, while the production path uses the
same requirements, receipts, evidence rules, and verification against the real
Playwright guest.
