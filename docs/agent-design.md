# Helm — Agent Design

## The ReAct Loop

Helm's agent follows the ReAct (Reason + Act) paradigm, a well-established approach for building language model agents that need to take sequences of grounded actions.

```
User goal
    │
    ▼
┌──────────────────────────────────────────────────────┐
│                   Agent Step N                       │
│                                                      │
│  1. REASON  ─── What do I see? What should I do?    │
│  2. ACT     ─── Issue one tool call                 │
│  3. OBSERVE ─── Receive tool result (+ screenshot)  │
│  4. CHECK   ─── Is the goal complete?               │
│                 YES → respond to user and stop       │
│                 NO  → go to step N+1                 │
└──────────────────────────────────────────────────────┘
```

The agent is driven by the Vercel AI SDK's `streamText` function with `stopWhen: [stepCountIs(MAX_STEPS)]`. Each step:
1. The model receives the system prompt, user goal, desktop resolution, recent conversation transcript, and all prior tool results.
2. The model emits a reasoning delta (thinking out loud) followed by a tool call or a final text response.
3. The server executes the tool call against the desktop container.
4. The result (including any screenshot data) is appended to the message context.
5. The loop continues until the model produces a text response (indicating goal completion) or the step limit is reached.

## System Prompt Structure

The system prompt is assembled by `buildAgentSystemPrompt()` and contains the following sections in order:

```
1. Role definition
   "You are Helm, an autonomous desktop automation agent."

2. OBSERVE → ACT → VERIFY loop instructions

3. Task completion criteria
   (when to stop using tools and report back)

4. Visual interaction rules
   (how to click, type, navigate, open apps)

5. Fallback rules
   (what to do when visual actions fail twice)

6. Truth rules
   - CRITICAL: do not hallucinate screenshot content from training knowledge
   - Only describe what is literally visible in the most recent image

7. [Optional] Custom user instructions
   (injected from the user's Settings panel — high-priority rules)

8. [Optional] Context summary
   (compressed summary of earlier messages in this conversation)

9. [Optional] Background memory context
   (retrieved episodic memories and semantic embeddings from past runs)
```

The ordering is deliberate: task-specific rules and truth constraints come before memory context, ensuring the model cannot rationalise away its core operating instructions using retrieved background.

## Screenshot Pruning (prepareStep)

A key challenge in long agentic runs is that base64-encoded screenshot data accumulates in the multi-step context, consuming tokens and causing the model to confuse earlier desktop states with the current one.

Helm addresses this with a `prepareStep` hook in the AI SDK's `streamText` call. Before each new step begins, the hook scans the accumulated messages, identifies the most recent screenshot tool result, and strips the `file-data` (the base64 image) from all *older* screenshot results. Only the most recent screenshot remains as an actual image; older ones are replaced with their textual summary.

```
Step 1:  screenshot₁ (image) ← kept
Step 2:  screenshot₂ (image) ← pruned to text summary
Step 3:  screenshot₃ (image) ← pruned to text summary
Step 4:  screenshot₄ (image) ← kept (most recent)
```

This has two effects:
- **Accuracy**: the model can only "see" the current desktop state, preventing hallucination based on stale screenshots.
- **Efficiency**: token consumption is bounded regardless of how many screenshots are taken in a run.

## Tool System

All tools are defined in `apps/server/src/agent/tools/` and exposed to the model via the AI SDK's tool API. Each tool has a JSON schema for its input and produces a structured output that may include text fields and optional screenshot data.

### Available Tools

| Tool | Description |
|------|-------------|
| `capture_screenshot` | Takes a screenshot of the current desktop state; returns base64 image + cursor position + window list |
| `move_mouse` | Moves the cursor to absolute coordinates |
| `click_mouse` | Clicks at the current cursor position (left/right/middle, single/double) |
| `type_text` | Types a string of text at the current focus |
| `press_key` | Presses a keyboard shortcut or special key (Enter, Tab, Escape, etc.) |
| `open_application` | Opens or focuses a named application |
| `list_desktop_windows` | Lists all currently open windows with their titles and positions |
| `navigate_browser_url` | Navigates Firefox to a given URL (uses the browser's address bar) |
| `run_terminal_command` | Executes a shell command silently and returns stdout/stderr |
| `create_file` | Creates or overwrites a file with given content |
| `read_file` | Reads the content of a file |
| `delete_file` | Deletes a file |

### Tool Execution Flow

```
Model emits tool_call { toolName, input }
    │
    ▼
Server: tool handler function runs
    │
    ├── Validates input against tool schema
    │
    ├── Calls desktop container HTTP endpoint
    │   e.g. POST /screenshot, POST /mouse/move, POST /keyboard/type
    │
    └── Returns structured output
         { ok: true, ... } or { ok: false, error: "..." }
    │
    ▼
AI SDK: tool result appended to messages
    │
    ▼
Model: sees result, reasons about next step
```

## Visual Interaction Strategy

The agent is instructed to follow a strict visual interaction protocol:

1. **See before acting**: always capture a screenshot before clicking or typing to confirm the current state.
2. **Verify after acting**: capture a screenshot after each interaction to confirm it had the expected effect.
3. **Coordinate-based clicks**: all clicks are issued at pixel coordinates derived from the most recent screenshot, not from DOM selectors or application-specific APIs.
4. **Focus verification**: before typing, verify the correct input field has keyboard focus by examining the screenshot.
5. **Failure recovery**: if the same visual action fails twice (verified by screenshots), stop and report the failure to the user rather than attempting a third time.

This strategy makes the agent robust across different applications and UI frameworks, since it interacts with the desktop at the display-pixel level rather than through application-specific APIs.

## Run Lifecycle

```
POST /api/conversations/:id/runs
    │
    ├── User message appended to SQLite
    ├── Run record created (status: 'queued')
    └── microtask queued → runAgentConversation()

runAgentConversation():
    ├── markRunRunning()
    ├── publishRunEvent('run_started')
    ├── maybeSummarizeConversation()     ← compress if needed
    ├── queryMemories() + queryEpisodes() ← RAG retrieval
    ├── buildAgentSystemPrompt()          ← assemble prompt
    ├── streamText() ReAct loop           ← agent executes
    │       ├── prepareStep: prune old screenshots
    │       ├── model reasons + calls tools
    │       └── publishRunEvent() for each delta
    ├── appendMessage(assistant response)
    ├── markRunCompleted()
    ├── publishRunEvent('run_completed')
    ├── upsertRunEpisode() + upsertMemory() ← persist to ChromaDB
    └── maybeSummarizeConversation()     ← post-run check
```

## Error Handling

- **Run cancellation**: the client can POST to `.../cancel` at any time. A cooperative abort signal is checked between tool calls. The current tool call is allowed to complete before the agent stops.
- **Tool failure**: tools return `{ ok: false, error: "..." }` rather than throwing. The model sees the error and can decide to retry or report it.
- **Stream disconnection**: the client implements automatic reconnection. If the stream drops, the client re-opens it against the same run ID and replays any missed events from the server's event log.
- **Step limit**: if `AGENT_MAX_STEPS` is reached, the `streamText` loop halts naturally and the model produces a final response with whatever it has accomplished.
