## Project goal

Helm is a general-purpose local computer-use agent harness.

It must behave like a normal capable assistant with tools:

```text
user
-> model
-> tool call
-> real tool result
-> same model
-> more tool calls if needed
-> final response
```

Helm is not a collection of hardcoded workflows.

The language model owns semantic reasoning. The harness owns safe execution.

When changing agent behavior, optimize for generality across arbitrary user requests, not for passing one prompt, demo, benchmark, fixture, or test.

---

## Core architecture rule

Never move task-specific intelligence from the model into deterministic application code merely to make a failing task pass.

The runtime should understand things such as:

- tool schemas
- filesystem boundaries
- browser state
- desktop state
- successful and failed side effects
- action receipts
- execution budgets
- cancellation
- retries
- loop detection
- persistence

The runtime should generally not need to understand things such as:

- what sections belong in a portfolio
- what information about a GitHub profile is interesting
- what makes a poem good
- what fields belong in a report
- how a requested webpage should be designed
- what repository facts matter to the user's request
- how to phrase user-facing content
- arbitrary domain concepts mentioned by the user

Those belong to the model.

---

## Do not hardcode around failing prompts

When debugging an agent failure, never fix it by adding prompt-specific behavior such as:

```ts
if (request.includes('followers')) { ... }

if (request.includes('pinned repos')) { ... }

if (request.includes('poem')) { ... }

if (request.includes('portfolio')) { ... }
```

Do not add equivalent regexes, keyword tables, task names, fact IDs, special requirements, or hidden deterministic workflows.

Bad fixes include:

```text
followers
pinnedRepositories
portfolioHtml
poemContent
githubProfile
latestFoo
specialDemoCase
```

as new runtime concepts solely because a failing test or demo used those concepts.

If a general-purpose model already understands the concept, Helm should normally leave the concept to the model.

---

## Do not overfit tests or demos

Tests exist to verify the architecture.

The architecture does not exist to satisfy individual tests.

Never introduce production behavior whose main justification is:

- "this makes the acceptance test pass"
- "this fixes the demo prompt"
- "the benchmark expects this"
- "the fixture contains this value"
- "this is easier to verify deterministically"

A fix must still make sense if all example prompts and fixtures are replaced tomorrow.

Before implementing a behavior, ask:

> Would this code still make sense for an unrelated user request in another domain?

If the answer is no, the behavior probably belongs in model reasoning rather than the harness.

It is acceptable to change or delete a test if the test encodes a bad architecture.

---

## Never fake task completion

Do not create an illusion of success.

Helm must never report that an external action happened unless there is real execution evidence for that action.

Examples:

If the assistant says it saved a file, there must be a successful filesystem mutation.

If the assistant says it opened a page, browser state must show that navigation occurred.

If the assistant says it downloaded a file, a real downloaded artifact must exist.

If the assistant says it opened a desktop file or application, desktop state should support that claim when the capability exists.

Do not replace a failed action with prose explaining what the user could manually do.

Do not generate a fake result simply so verification passes.

Do not silently turn an execution request into an informational answer.

---

## Verification must not become the brain

Verification should validate concrete effects.

Good verification:

```text
Did fs.write succeed?
Does the file exist?
Did browser.navigate reach a page?
Did browser.read return usable page content?
Did the download produce an artifact?
Is the requested window open?
Did the environment change?
Is the agent repeating itself?
```

Bad verification:

```text
Does this portfolio contain the correct sections?
Did the poem satisfy our idea of poetry?
Which GitHub facts should the user care about?
What content should be written into this report?
How should this HTML page be designed?
```

Do not build a second semantic agent inside deterministic verification code.

The model determines semantic completion.

The runtime verifies concrete claims and side effects.

---

## Do not generate semantic artifacts deterministically

When the user asks for an artifact such as:

- HTML
- Markdown
- source code
- a poem
- a report
- JSON
- a letter
- a document
- prose
- a summary

the model should generate the content.

The harness may write, read, hash, inspect, validate, or persist that content.

The harness must not replace it with deterministic content assembled from internal facts unless the user explicitly requested such a serialization format.

Avoid code such as:

```ts
facts.map((fact) => `${fact.label}: ${fact.value}`).join('\n');
```

as a substitute for model-generated user-facing output.

A request for a website must produce model-generated website content, not a fact dump written into an `.html` file.

---

## Preserve the original user intent

Do not reduce arbitrary natural-language requests into a tiny closed ontology before the acting model sees them.

The acting model should have access to:

- the original user request
- relevant conversation history
- useful tool results
- relevant environment state

Do not discard semantic details because the runtime cannot represent them as a predefined requirement type.

If a compiler, planner, router, or state representation loses information from the user's request, change that layer instead of teaching it every possible future concept.

---

## Prefer native tool calling

For normal agent execution, expose actual tools to the model through the model/tool API.

Do not stringify a tool catalog into a prompt and ask the model to imitate tool calls using arbitrary JSON unless native tool calling is genuinely unavailable.

Prefer:

```text
assistant -> native tool call
tool -> result
assistant -> next tool call
```

over:

```text
assistant -> {"tool":"foo","input":...}
custom parser
runtime
another model invocation
```

Tool results should return to the same acting-model context whenever practical.

The model should be able to observe an error from its own action and recover from it.

---

## Maintain coherent agent context

Do not unnecessarily split a simple task across multiple independent model roles.

Planner, orchestrator, worker, verifier, and response-generator layers are only justified when they improve behavior enough to offset context fragmentation.

For ordinary computer-use tasks, prefer one coherent acting agent.

A tool result discovered during research must remain available when the agent later creates the requested artifact.

Do not compress away information the current task still needs.

---

## Conversation must remain conversation

Normal chat must work without computer use.

Examples:

```text
write me a poem
explain Kubernetes
what can you do?
rewrite this paragraph
```

These should produce ordinary assistant responses unless the user requested an external action.

Do not open the browser, start computer-use workflows, or fabricate requirements for a conversational request.

Follow-up references should work naturally:

```text
User: write me a poem
Assistant: ...
User: save it to a text file
```

The second turn should have access to the poem.

Do not require the user to restate content that already exists in conversation history.

---

## Distinguish unknown facts from reasonable choices

Never invent external facts.

Examples that require observation:

- follower counts
- current prices
- page contents
- repository metadata
- current UI state
- whether an operation succeeded

But do not treat harmless implementation choices as forbidden invention.

Examples the model may reasonably choose when the user did not specify them:

- a sensible filename
- HTML layout
- CSS structure
- section ordering
- variable names
- formatting details
- wording
- visual styling

Do not require every minor implementation decision to appear literally in the user's prompt.

---

## Browser behavior

Use the browser because the task requires browser information or interaction, not because a keyword triggered a broad heuristic.

Do not open the browser for:

```text
write a poem and save it as poem.txt
```

Do use the browser for:

```text
open github.com/example and inspect the profile
```

URLs may also be values rather than destinations.

For example, an image URL supplied for use inside generated HTML does not automatically need to be navigated to.

Prefer model reasoning plus generic tool guards over large URL-role parsing systems.

---

## Generic tool guards are good

The following kinds of deterministic restrictions are appropriate:

- rejecting paths outside the allowed filesystem sandbox
- rejecting invalid browser protocols
- enforcing tool schemas
- enforcing worker/action budgets
- preventing access to unavailable capabilities
- validating required permissions
- timing out hung operations
- preventing exact repeated no-progress loops
- checking that claimed side effects happened
- preventing a browser tool from being passed an obvious filesystem path

These rules protect execution semantics.

They do not teach Helm how to solve a particular user's task.

---

## Avoid regex-driven semantics

Regexes are acceptable for low-level syntax and validation.

Examples:

- parsing a file extension
- validating a URL
- validating a protocol
- recognizing an absolute path
- sanitizing tool input

Regexes should not be the primary mechanism for understanding arbitrary user intent.

Be suspicious of code that tries to infer complex task semantics from lists of phrases such as:

```text
"find"
"research"
"create"
"latest"
"profile"
"repo"
"portfolio"
```

If adding another phrase fixes only another family of prompts, stop and reconsider the architecture.

---

## Do not bypass the model to satisfy guardrails

A guardrail should reject invalid or unsupported behavior.

It should not silently perform the model's work itself.

Bad:

```text
model fails to generate content
-> runtime constructs expected content
-> verifier passes
-> task appears
```
