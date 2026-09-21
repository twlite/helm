# Agent loop

Every run follows an explicit ReAct-shaped trace without persisting hidden chain-of-thought.

```text
observe environment
      ↓
reason: short operational summary
      ↓
act: validated tool call
      ↓
observe actual result/state
      ↓
verify mechanical criteria
      ↓
repeat or finish
```

Each persisted step can show `Reason`, `Action`, `Observation`, and `Verification` in the UI. The summary is operational and displayable; it is not a transcript of private model reasoning.

## Completion ownership

A decision provider may request `complete`, but that request only invokes the verifier. Known criteria such as `file.exists`, `file.contains`, `browser.url`, `window.open`, and `window.focused` are checked against actual guest state. A run becomes `completed` only when every criterion passes.

## Safety

The runtime enforces a total step budget, repeated-action limit, consecutive-failure limit, per-tool timeout, and cancellation. Action fingerprints include the tool, normalized input, and relevant observed result. Repeating an action that produces the same state creates a visible loop-detected failure instead of retrying forever.

The scripted provider intentionally includes a premature-completion scenario in tests. This protects the central invariant that a first successful action is not the same as a completed task.
