import type {
  EnvironmentObservation,
  TaskDefinition,
  ToolResult,
  WindowInfo,
} from '@helm/shared';

import type { GuestTransport } from '../tools/guest-transport';
import type { ObservationInput, ObservationProvider } from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export interface EnvironmentObservationOptions {
  guest: GuestTransport;
  now?: () => number;
}

/**
 * Reads semantic guest state for a turn. A missing subsystem is represented by
 * an absent observation rather than turning a harmless diagnostic read into a
 * fake success.
 */
export async function observeEnvironment(
  input: ObservationInput,
  options: EnvironmentObservationOptions,
): Promise<EnvironmentObservation> {
  const [browserResult, desktopResult] = await Promise.all([
    options.guest.request('browser.getState', {}, { signal: input.signal })
      .then(value => ({ status: 'fulfilled' as const, value }))
      .catch(reason => ({ status: 'rejected' as const, reason })),
    options.guest.request('desktop.getState', {}, { signal: input.signal })
      .then(value => ({ status: 'fulfilled' as const, value }))
      .catch(reason => ({ status: 'rejected' as const, reason })),
  ]);
  const browserSnapshotResult = browserResult.status === 'fulfilled'
    ? await options.guest.request('browser.snapshot', {}, { signal: input.signal })
        .then(value => ({ status: 'fulfilled' as const, value }))
        .catch(reason => ({ status: 'rejected' as const, reason }))
    : { status: 'rejected' as const, reason: browserResult.reason };

  const browser = browserResult.status === 'fulfilled' && isRecord(browserResult.value)
    ? {
        ...(typeof browserResult.value.url === 'string' ? { url: browserResult.value.url } : {}),
        ...(typeof browserResult.value.title === 'string' ? { title: browserResult.value.title } : {}),
        ...(typeof browserResult.value.loaded === 'boolean' ? { loaded: browserResult.value.loaded } : {}),
        ...(typeof browserResult.value.domFingerprint === 'string' ? { domFingerprint: browserResult.value.domFingerprint } : {}),
        ...(browserSnapshotResult.status === 'fulfilled' && isRecord(browserSnapshotResult.value)
          ? {
            ...(typeof browserSnapshotResult.value.pageCount === 'number' ? { pageCount: browserSnapshotResult.value.pageCount } : {}),
            ...(isRecord(browserSnapshotResult.value.main) ? { main: browserSnapshotResult.value.main as { heading?: string; text?: string } } : {}),
            ...(Array.isArray(browserSnapshotResult.value.elements)
              ? {
                interactiveElements: browserSnapshotResult.value.elements
                  .filter(isRecord)
                  .map(element => ({
                    ref: typeof element.ref === 'string' ? element.ref : '',
                    role: typeof element.role === 'string' ? element.role : 'unknown',
                    name: typeof element.name === 'string' ? element.name : '',
                    ...(typeof element.value === 'string' ? { value: element.value } : {}),
                    ...(typeof element.text === 'string' ? { text: element.text } : {}),
                    enabled: element.enabled !== false,
                    ...(typeof element.href === 'string' ? { href: element.href } : {}),
                    ...(typeof element.checked === 'boolean' ? { checked: element.checked } : {}),
                    ...(typeof element.selected === 'boolean' ? { selected: element.selected } : {}),
                  }))
                  .filter(element => element.ref.length > 0),
              }
            : {}),
          }
          : {}),
      }
    : undefined;
  const desktop = desktopResult.status === 'fulfilled' && isRecord(desktopResult.value)
    ? {
        ...(isRecord(desktopResult.value.focusedWindow)
          ? { focusedWindow: desktopResult.value.focusedWindow as WindowInfo }
          : {}),
        ...(Array.isArray(desktopResult.value.windows)
          ? { windows: desktopResult.value.windows as WindowInfo[] }
          : {}),
        ...(typeof desktopResult.value.screenshotId === 'string'
          ? { screenshotId: desktopResult.value.screenshotId }
          : {}),
      }
    : undefined;

  return {
    timestamp: options.now?.() ?? Date.now(),
    ...(browser ? { browser } : {}),
    ...(desktop ? { desktop } : {}),
    ...(input.lastToolResult ? { lastToolResult: input.lastToolResult } : {}),
    task: {
      completedCriteria: [...input.completedCriteria],
      remainingCriteria: [...input.remainingCriteria],
    },
  };
}

export class GuestObservationProvider implements ObservationProvider {
  private readonly options: EnvironmentObservationOptions;

  constructor(options: EnvironmentObservationOptions) {
    this.options = options;
  }

  observe(input: ObservationInput): Promise<EnvironmentObservation> {
    return observeEnvironment(input, this.options);
  }
}

export type RuntimeObservationProvider = GuestObservationProvider;

export function initialObservationInput(
  task: TaskDefinition,
  lastToolResult?: ToolResult,
): ObservationInput {
  return {
    task,
    completedCriteria: [],
    remainingCriteria: task.criteria.map(criterion => criterion.type),
    lastToolResult,
  };
}
