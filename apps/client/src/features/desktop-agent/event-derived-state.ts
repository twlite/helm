import type { AgentCursorPosition } from "./desktop-vnc-panel";
import type { LiveEvent } from "./types";

export type { LiveEvent };

const MOUSE_TOOL_NAMES = new Set([
  "capture_screenshot",
  "click_mouse",
  "double_click_mouse",
  "drag_mouse",
  "get_mouse_location",
  "move_mouse",
]);

const CLICK_TOOL_NAMES = new Set(["click_mouse", "double_click_mouse"]);

const asRecord = (value: unknown): Record<string, unknown> | null => {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
};

const getNumber = (record: Record<string, unknown> | null, key: string): number | null => {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const hasFractionalPart = (value: number): boolean => !Number.isInteger(value);

const resolveRawPoint = (
  point: { x: number; y: number },
  geometry: { width: number; height: number },
): { x: number; y: number } => {
  if (
    point.x >= 0 &&
    point.x <= 1 &&
    point.y >= 0 &&
    point.y <= 1 &&
    (hasFractionalPart(point.x) || hasFractionalPart(point.y))
  ) {
    return {
      x: point.x * Math.max(0, geometry.width - 1),
      y: point.y * Math.max(0, geometry.height - 1),
    };
  }

  const maxX = Math.max(0, geometry.width - 1);
  const maxY = Math.max(0, geometry.height - 1);
  if (
    point.x >= 0 &&
    point.x <= 1000 &&
    point.y >= 0 &&
    point.y <= 1000 &&
    (point.x > maxX || point.y > maxY)
  ) {
    return {
      x: (point.x / 1000) * maxX,
      y: (point.y / 1000) * maxY,
    };
  }

  return point;
};

const extractPoint = (
  output: Record<string, unknown>,
  geometry: { width: number; height: number },
): { x: number; y: number } | null => {
  const cursor = asRecord(output.cursor);
  const resolvedTarget = asRecord(output.resolvedTarget);
  const cursorAfter = asRecord(output.cursorAfter);
  const cursorAfterMove = asRecord(output.cursorAfterMove);
  const movedTo = asRecord(output.movedTo);

  const candidates = [
    { x: getNumber(cursorAfterMove, "x"), y: getNumber(cursorAfterMove, "y") },
    { x: getNumber(resolvedTarget, "x"), y: getNumber(resolvedTarget, "y") },
    { x: getNumber(movedTo, "x"), y: getNumber(movedTo, "y") },
    { x: getNumber(cursorAfter, "x"), y: getNumber(cursorAfter, "y") },
    { x: getNumber(cursor, "x"), y: getNumber(cursor, "y") },
    { x: getNumber(output, "x"), y: getNumber(output, "y"), needsResolution: true },
  ];

  const match = candidates.find((point) => point.x !== null && point.y !== null);
  if (!match) {
    return null;
  }

  const point = { x: match.x as number, y: match.y as number };
  return "needsResolution" in match ? resolveRawPoint(point, geometry) : point;
};

const extractGeometry = (
  output: Record<string, unknown>,
): { width: number; height: number } | null => {
  const geometry = asRecord(output.displayGeometry) ?? asRecord(output.geometry);
  const width = getNumber(geometry, "width");
  const height = getNumber(geometry, "height");

  return width && height && width > 0 && height > 0 ? { width, height } : null;
};

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export const deriveAgentCursor = (liveEvents: LiveEvent[]): AgentCursorPosition | null => {
  for (let index = liveEvents.length - 1; index >= 0; index -= 1) {
    const event = liveEvents[index];
    if (
      (event?.type !== "tool_result" && event?.type !== "tool_call") ||
      !MOUSE_TOOL_NAMES.has(event.toolName)
    ) {
      continue;
    }

    const payload = event.type === "tool_result" ? event.output : event.input;
    const geometry = extractGeometry(payload) ?? { width: 1366, height: 768 };
    const point = extractPoint(payload, geometry);
    if (!point) {
      continue;
    }

    return {
      clickKey: CLICK_TOOL_NAMES.has(event.toolName)
        ? `${index}-${event.type}-${event.toolName}-click`
        : null,
      eventKey: `${index}-${event.type}-${event.toolName}`,
      height: geometry.height,
      isClicking: event.type === "tool_call" && CLICK_TOOL_NAMES.has(event.toolName),
      width: geometry.width,
      xPercent: clampPercent((point.x / geometry.width) * 100),
      yPercent: clampPercent((point.y / geometry.height) * 100),
    };
  }

  return null;
};

export const deriveScreenshotFlashKey = (liveEvents: LiveEvent[]): string | null => {
  for (let index = liveEvents.length - 1; index >= 0; index -= 1) {
    const event = liveEvents[index];
    if (
      (event?.type === "tool_call" || event?.type === "tool_result") &&
      event.toolName === "capture_screenshot"
    ) {
      return `${index}-${event.type}-${event.toolName}-flash`;
    }
  }

  return null;
};
