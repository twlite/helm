import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  deriveScreenshotFlashKey,
  type LiveEvent,
} from "../src/features/desktop-agent/event-derived-state.ts";

describe("desktop agent event derived state", () => {
  it("returns a replayable flash key for the latest screenshot event", () => {
    const liveEvents: LiveEvent[] = [
      { type: "tool_result", toolName: "move_mouse", output: { x: 100, y: 120 } },
      { type: "tool_call", toolName: "capture_screenshot", input: {} },
    ];

    assert.equal(deriveScreenshotFlashKey(liveEvents), "1-tool_call-capture_screenshot-flash");
  });

  it("returns null when no screenshot event has occurred", () => {
    const liveEvents: LiveEvent[] = [
      { type: "tool_call", toolName: "click_mouse", input: { x: 100, y: 120 } },
    ];

    assert.equal(deriveScreenshotFlashKey(liveEvents), null);
  });
});
