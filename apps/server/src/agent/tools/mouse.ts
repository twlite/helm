import { MouseButton } from '@helm/desktop';
import { tool } from 'ai';
import { z } from 'zod';
import { desktopService } from '../../desktop/desktop-service.ts';
import {
  assertRunNotCancelled,
  type RuntimeToolDependencies,
} from './context.ts';
import { emitToolCall, emitToolResult } from './events.ts';

const MOVE_DRIFT_TOLERANCE_PX = 3;

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const hasFractionalPart = (value: number): boolean => {
  return !Number.isInteger(value);
};

const isLikelyNormalizedCoordinatePair = (x: number, y: number): boolean => {
  return (
    x >= 0 &&
    x <= 1 &&
    y >= 0 &&
    y <= 1 &&
    (hasFractionalPart(x) || hasFractionalPart(y))
  );
};

const isLikelyThousandScaleCoordinatePair = (
  x: number,
  y: number,
  geometry: { width: number; height: number } | null,
): boolean => {
  if (!geometry) {
    return false;
  }

  const withinThousandRange = x >= 0 && x <= 1000 && y >= 0 && y <= 1000;
  if (!withinThousandRange) {
    return false;
  }

  const maxX = Math.max(0, geometry.width - 1);
  const maxY = Math.max(0, geometry.height - 1);

  // Use thousand-scale normalization only when the raw pair exceeds display
  // bounds; otherwise treat numbers as absolute pixels.
  return x > maxX || y > maxY;
};

const resolveTargetPoint = async (x: number, y: number) => {
  const geometry = await desktopService.getDisplayGeometry().catch(() => null);

  let resolvedX = x;
  let resolvedY = y;
  let coordinateMode: 'absolute' | 'normalized' | 'normalized_1000' =
    'absolute';

  if (geometry && isLikelyNormalizedCoordinatePair(x, y)) {
    resolvedX = x * Math.max(0, geometry.width - 1);
    resolvedY = y * Math.max(0, geometry.height - 1);
    coordinateMode = 'normalized';
  } else if (geometry && isLikelyThousandScaleCoordinatePair(x, y, geometry)) {
    resolvedX = (x / 1000) * Math.max(0, geometry.width - 1);
    resolvedY = (y / 1000) * Math.max(0, geometry.height - 1);
    coordinateMode = 'normalized_1000';
  }

  if (geometry) {
    const maxX = Math.max(0, geometry.width - 1);
    const maxY = Math.max(0, geometry.height - 1);

    resolvedX = clamp(Math.round(resolvedX), 0, maxX);
    resolvedY = clamp(Math.round(resolvedY), 0, maxY);
  } else {
    resolvedX = Math.round(resolvedX);
    resolvedY = Math.round(resolvedY);
  }

  return {
    coordinateMode,
    displayGeometry: geometry,
    requestedTarget: { x, y },
    resolvedTarget: {
      x: resolvedX,
      y: resolvedY,
    },
  };
};

const moveWithVerification = async (x: number, y: number) => {
  await desktopService.moveMouse(x, y);
  let moved = await desktopService.getMouseLocation();

  const drift = Math.max(Math.abs(moved.x - x), Math.abs(moved.y - y));

  if (drift > MOVE_DRIFT_TOLERANCE_PX) {
    await desktopService.moveMouse(x, y);
    moved = await desktopService.getMouseLocation();
  }

  return moved;
};

const validateCoordinatePair = (
  value: { x?: number; y?: number },
  issueContext: z.core.$RefinementCtx,
) => {
  const hasX = typeof value.x === 'number';
  const hasY = typeof value.y === 'number';

  if (hasX !== hasY) {
    issueContext.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provide both x and y together when clicking by coordinate.',
      path: ['x'],
    });
  }
};

export const buildMouseTools = ({
  context,
  capture,
}: RuntimeToolDependencies) => {
  return {
    click_mouse: tool({
      description:
        'Click a mouse button. If provided, x and y are display pixel coordinates from the latest screenshot (origin at top-left). Values in [0,1] are treated as normalized coordinates.',
      inputSchema: z
        .object({
          button: z.enum(MouseButton).optional(),
          repeat: z.number().int().min(1).max(5).default(1),
          x: z.number().optional(),
          y: z.number().optional(),
        })
        .superRefine(validateCoordinatePair),
      execute: async ({ button, repeat, x, y }) => {
        assertRunNotCancelled(context);

        const selectedButton = button ?? MouseButton.Left;

        const callInput = {
          button: selectedButton,
          repeat,
          ...(typeof x === 'number' && typeof y === 'number' ? { x, y } : {}),
        };

        emitToolCall(context, 'click_mouse', { ...callInput });
        capture.onToolCall({ input: callInput, toolName: 'click_mouse' });

        const before = await desktopService.getMouseLocation();

        let moveDetails:
          | {
              coordinateMode: 'absolute' | 'normalized' | 'normalized_1000';
              cursorAfterMove: {
                x: number;
                y: number;
                screen: number;
                window: number;
              };
              displayGeometry: { width: number; height: number } | null;
              movedTo: { x: number; y: number };
              requestedTarget: { x: number; y: number };
              resolvedTarget: { x: number; y: number };
            }
          | undefined;

        if (typeof x === 'number' && typeof y === 'number') {
          const target = await resolveTargetPoint(x, y);
          const cursorAfterMove = await moveWithVerification(
            target.resolvedTarget.x,
            target.resolvedTarget.y,
          );

          moveDetails = {
            coordinateMode: target.coordinateMode,
            cursorAfterMove,
            displayGeometry: target.displayGeometry,
            movedTo: {
              x: target.resolvedTarget.x,
              y: target.resolvedTarget.y,
            },
            requestedTarget: target.requestedTarget,
            resolvedTarget: target.resolvedTarget,
          };
        }

        await desktopService.click(selectedButton, repeat);

        const after = await desktopService.getMouseLocation();

        const result = {
          button: selectedButton,
          cursorAfter: after,
          cursorBefore: before,
          ...(moveDetails ?? {}),
          repeat,
          ok: true,
        };

        emitToolResult(context, 'click_mouse', result);
        capture.onToolResult({ output: result, toolName: 'click_mouse' });
        return result;
      },
    }),
    double_click_mouse: tool({
      description:
        'Double-click a mouse button. If provided, x and y are display pixel coordinates from the latest screenshot (origin at top-left). Values in [0,1] are treated as normalized coordinates.',
      inputSchema: z
        .object({
          button: z.enum(MouseButton).optional(),
          x: z.number().optional(),
          y: z.number().optional(),
        })
        .superRefine(validateCoordinatePair),
      execute: async ({ button, x, y }) => {
        assertRunNotCancelled(context);

        const selectedButton = button ?? MouseButton.Left;

        const callInput = {
          button: selectedButton,
          repeat: 2,
          ...(typeof x === 'number' && typeof y === 'number' ? { x, y } : {}),
        };

        emitToolCall(context, 'double_click_mouse', { ...callInput });
        capture.onToolCall({
          input: callInput,
          toolName: 'double_click_mouse',
        });

        const before = await desktopService.getMouseLocation();

        let moveDetails:
          | {
              coordinateMode: 'absolute' | 'normalized' | 'normalized_1000';
              cursorAfterMove: {
                x: number;
                y: number;
                screen: number;
                window: number;
              };
              displayGeometry: { width: number; height: number } | null;
              movedTo: { x: number; y: number };
              requestedTarget: { x: number; y: number };
              resolvedTarget: { x: number; y: number };
            }
          | undefined;

        if (typeof x === 'number' && typeof y === 'number') {
          const target = await resolveTargetPoint(x, y);
          const cursorAfterMove = await moveWithVerification(
            target.resolvedTarget.x,
            target.resolvedTarget.y,
          );

          moveDetails = {
            coordinateMode: target.coordinateMode,
            cursorAfterMove,
            displayGeometry: target.displayGeometry,
            movedTo: {
              x: target.resolvedTarget.x,
              y: target.resolvedTarget.y,
            },
            requestedTarget: target.requestedTarget,
            resolvedTarget: target.resolvedTarget,
          };
        }

        await desktopService.click(selectedButton, 2);

        const after = await desktopService.getMouseLocation();

        const result = {
          button: selectedButton,
          cursorAfter: after,
          cursorBefore: before,
          ...(moveDetails ?? {}),
          repeat: 2,
          ok: true,
        };

        emitToolResult(context, 'double_click_mouse', result);
        capture.onToolResult({
          output: result,
          toolName: 'double_click_mouse',
        });
        return result;
      },
    }),
    drag_mouse: tool({
      description:
        'Drag the mouse pointer to target coordinates. x and y are display pixel coordinates from the latest screenshot (origin at top-left).',
      inputSchema: z.object({
        x: z.number(),
        y: z.number(),
      }),
      execute: async ({ x, y }) => {
        assertRunNotCancelled(context);
        const callInput = { x, y };
        emitToolCall(context, 'drag_mouse', callInput);
        capture.onToolCall({ input: callInput, toolName: 'drag_mouse' });

        const target = await resolveTargetPoint(x, y);

        await desktopService.dragMouseTo(
          target.resolvedTarget.x,
          target.resolvedTarget.y,
        );

        const result = {
          coordinateMode: target.coordinateMode,
          displayGeometry: target.displayGeometry,
          ok: true,
          requestedTarget: target.requestedTarget,
          resolvedTarget: target.resolvedTarget,
          x: target.resolvedTarget.x,
          y: target.resolvedTarget.y,
        };
        emitToolResult(context, 'drag_mouse', result);
        capture.onToolResult({ output: result, toolName: 'drag_mouse' });
        return result;
      },
    }),
    get_mouse_location: tool({
      description: 'Return the current mouse location.',
      inputSchema: z.object({}),
      execute: async () => {
        assertRunNotCancelled(context);
        emitToolCall(context, 'get_mouse_location', {});
        capture.onToolCall({ input: {}, toolName: 'get_mouse_location' });

        const location = await desktopService.getMouseLocation();

        emitToolResult(context, 'get_mouse_location', location);
        capture.onToolResult({
          output: location,
          toolName: 'get_mouse_location',
        });

        return location;
      },
    }),
    move_mouse: tool({
      description:
        'Move the mouse pointer to target coordinates. x and y are display pixel coordinates from the latest screenshot (origin at top-left).',
      inputSchema: z.object({
        x: z.number(),
        y: z.number(),
      }),
      execute: async ({ x, y }) => {
        assertRunNotCancelled(context);
        const callInput = { x, y };
        emitToolCall(context, 'move_mouse', callInput);
        capture.onToolCall({ input: callInput, toolName: 'move_mouse' });

        const target = await resolveTargetPoint(x, y);

        const cursorAfterMove = await moveWithVerification(
          target.resolvedTarget.x,
          target.resolvedTarget.y,
        );

        const result = {
          coordinateMode: target.coordinateMode,
          cursorAfterMove,
          displayGeometry: target.displayGeometry,
          ok: true,
          requestedTarget: target.requestedTarget,
          resolvedTarget: target.resolvedTarget,
          x: target.resolvedTarget.x,
          y: target.resolvedTarget.y,
        };
        emitToolResult(context, 'move_mouse', result);
        capture.onToolResult({ output: result, toolName: 'move_mouse' });
        return result;
      },
    }),
    scroll_mouse: tool({
      description: 'Scroll the mouse wheel by amount in up/down direction.',
      inputSchema: z.object({
        amount: z.number().int().min(1).max(30).default(1),
        direction: z.enum(['up', 'down']),
      }),
      execute: async ({ direction, amount }) => {
        assertRunNotCancelled(context);
        const callInput = { amount, direction };
        emitToolCall(context, 'scroll_mouse', callInput);
        capture.onToolCall({ input: callInput, toolName: 'scroll_mouse' });

        await desktopService.scroll(direction, amount);

        const result = { amount, direction, ok: true };
        emitToolResult(context, 'scroll_mouse', result);
        capture.onToolResult({ output: result, toolName: 'scroll_mouse' });
        return result;
      },
    }),
  };
};
