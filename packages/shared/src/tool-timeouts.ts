import type { GuestMethod } from './types';

/** Nested guest/tool deadlines. Each enclosing timeout includes bounded cleanup/serialization grace. */
export const GUEST_TOOL_DEADLINES_MS = {
  browserNavigate: { pageNavigation: 30_000, operation: 40_000, guestRpc: 45_000, hostCommand: 50_000, serverTool: 55_000 },
  browserOpen: { operation: 40_000, guestRpc: 45_000, hostCommand: 50_000, serverTool: 55_000 },
  browserDownload: { operation: 35_000, guestRpc: 40_000, hostCommand: 45_000, serverTool: 50_000 },
  browserWebSearch: { operation: 22_000, guestRpc: 27_000, hostCommand: 32_000, serverTool: 37_000 },
  browserInspection: { operation: 10_000, guestRpc: 15_000, hostCommand: 20_000, serverTool: 25_000 },
  browserInteraction: { operation: 15_000, guestRpc: 20_000, hostCommand: 25_000, serverTool: 30_000 },
  filesystemWrite: { operation: 10_000, guestRpc: 15_000, hostCommand: 20_000, serverTool: 25_000 },
} as const;

export const GUEST_VM_HOST_GRACE_MS = 5_000;

export function assertNestedDeadlines(
  deadlines: { operation: number; guestRpc: number; hostCommand: number; serverTool: number },
): boolean {
  return deadlines.operation < deadlines.guestRpc
    && deadlines.guestRpc < deadlines.hostCommand
    && deadlines.hostCommand < deadlines.serverTool;
}

export function guestRpcTimeoutFor(method: GuestMethod): number | undefined {
  if (method === 'browser.navigate') return GUEST_TOOL_DEADLINES_MS.browserNavigate.guestRpc;
  if (method === 'browser.open') return GUEST_TOOL_DEADLINES_MS.browserOpen.guestRpc;
  if (method === 'browser.download') return GUEST_TOOL_DEADLINES_MS.browserDownload.guestRpc;
  if (method === 'browser.webSearch') return GUEST_TOOL_DEADLINES_MS.browserWebSearch.guestRpc;
  if ([
    'browser.read', 'browser.findPage', 'browser.snapshot', 'browser.query', 'browser.evaluate',
    'browser.inspectRegion', 'browser.getState',
  ].includes(method)) return GUEST_TOOL_DEADLINES_MS.browserInspection.guestRpc;
  if (method === 'browser.click' || method === 'browser.type') return GUEST_TOOL_DEADLINES_MS.browserInteraction.guestRpc;
  if (method === 'fs.write') return GUEST_TOOL_DEADLINES_MS.filesystemWrite.guestRpc;
  if (method === 'desktop.getState') return GUEST_TOOL_DEADLINES_MS.browserInspection.guestRpc;
  return undefined;
}
