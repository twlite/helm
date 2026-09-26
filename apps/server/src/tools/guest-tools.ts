import { browserUrlsMatch, guestMethodSchemas } from '@helm/shared';
import type { ActionReceipt, GuestMethod, ToolError, ToolResult } from '@helm/shared';
import { z } from 'zod';

import type {
  GuestMethodParams,
  GuestTransport,
  GuestTransportError,
} from './guest-transport';
import { ToolRegistry, type ToolRegistryOptions } from './tool-registry';

const TOOL_DESCRIPTIONS: Partial<Record<GuestMethod, string>> = {
  'guest.handshake': 'Check the guest protocol and capabilities.',
  'fs.read': 'Read a UTF-8 file inside the allowed guest filesystem root.',
  'fs.write': 'Write a UTF-8 file inside the allowed guest filesystem root. Use content for model-generated text or sourceRef plus an optional format to copy a full browser artifact deterministically.',
  'fs.mkdir': 'Create a directory inside the allowed guest filesystem root.',
  'fs.exists': 'Check whether a guest filesystem path exists.',
  'fs.list': 'List immediate entries inside an allowed guest directory.',
  'fs.stat': 'Inspect whether a guest filesystem path exists and its type.',
  'browser.navigate': 'Navigate the visible guest browser to a URL.',
  'browser.getState': 'Read the visible browser URL, title, loading state, page count, and current DOM revision without reading page text.',
  'browser.snapshot': 'Return a bounded semantic outline of the current page and its visible interactive elements.',
  'browser.read': 'Read a compact semantic overview or retrieve locally ranked page blocks for a query. Results include typed blocks and current-page content refs; use a block ref with fs.write sourceRef to transfer complete extracted content without copying it into tool arguments. Use a content ref with offset and limit to inspect more rows or items.',
  'browser.search': 'Search page content for a specific query and return bounded matching snippets and refs. Zero matches describe only this query; pageReadable reports whether the page has readable content.',
  'browser.inspectRegion': 'Inspect one current page region as bounded text, structured table rows, or local links. Large tables support offset and limit pagination.',
  'browser.download': 'Start and record a browser download from a semantic element or URL.',
  'browser.click': 'Click a semantic browser element or desktop coordinate fallback.',
  'browser.type': 'Type into a semantic browser element.',
  'app.launch': 'Launch one of the explicitly supported guest applications.',
  'app.openFile': 'Open a guest file in an explicitly supported application.',
  'desktop.getState': 'Read guest windows and the focused window.',
  'desktop.listWindows': 'List guest windows.',
  'desktop.focusWindow': 'Focus a matching guest window.',
  'desktop.hotkey': 'Send a keyboard shortcut to the guest desktop.',
  'desktop.type': 'Type text into the focused guest desktop application.',
  'desktop.click': 'Click a coordinate on the guest desktop.',
  'desktop.screenshot': 'Capture one current guest desktop screenshot.',
};

function transportFailure(error: unknown): ToolResult {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const typed = error as GuestTransportError;
    return {
      ok: false,
      error: {
        code: String(typed.code),
        message: String(typed.message),
        ...(typed.details === undefined ? {} : { details: typed.details }),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'GUEST_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

type BoundarySnapshot = {
  browser?: { url?: string; title?: string; pageCount?: number; revision?: number };
  filesystem?: { path: string; exists: boolean; type?: string; size?: number };
  desktop?: unknown;
};

async function boundarySnapshot(
  guest: GuestTransport,
  method: GuestMethod,
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<BoundarySnapshot> {
  const snapshot: BoundarySnapshot = {};
  if (method.startsWith('browser.') && ![
    'browser.read', 'browser.snapshot', 'browser.search', 'browser.inspectRegion', 'browser.getState',
  ].includes(method)) {
    try {
      const state = await guest.request('browser.getState', {}, { signal });
      snapshot.browser = { url: state.url, title: state.title, pageCount: state.pageCount, revision: state.revision };
    } catch {
      // The receipt still records the action if the browser was unavailable.
    }
  }
  if (method === 'fs.write' || method === 'fs.mkdir' || method === 'fs.read' || method === 'fs.stat' || method === 'fs.exists') {
    const path = typeof input.path === 'string' ? input.path : undefined;
    if (path) {
      try {
        const state = await guest.request('fs.stat', { path }, { signal });
        snapshot.filesystem = state;
      } catch {
        snapshot.filesystem = { path, exists: false };
      }
    }
  }
  if (method.startsWith('desktop.') || method.startsWith('app.')) {
    try {
      snapshot.desktop = await guest.request('desktop.getState', {}, { signal });
    } catch {
      // Desktop is optional in browser-only tasks.
    }
  }
  return snapshot;
}

function recordError(error: unknown): ToolError {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const typed = error as GuestTransportError;
    return {
      code: String(typed.code),
      message: String(typed.message),
      ...(typed.details === undefined ? {} : { details: typed.details }),
    };
  }
  return { code: 'GUEST_ERROR', message: error instanceof Error ? error.message : String(error) };
}

function receiptEffect(
  method: GuestMethod,
  input: Record<string, unknown>,
  before: BoundarySnapshot,
  after: BoundarySnapshot,
  data: unknown,
): ActionReceipt['effect'] {
  const dataRecord = typeof data === 'object' && data !== null && !Array.isArray(data)
    ? data as Record<string, unknown>
    : undefined;
  const effect: ActionReceipt['effect'] = {};
  if (before.browser || after.browser) {
    if (method === 'browser.navigate' && typeof input.url === 'string') {
      effect.requestedUrl = input.url;
    }
    const urlBefore = before.browser?.url;
    const urlAfter = after.browser?.url ?? (typeof dataRecord?.url === 'string' ? dataRecord.url : undefined);
    effect.urlBefore = urlBefore;
    effect.urlAfter = urlAfter;
    if (method === 'browser.navigate' && typeof input.url === 'string' && urlAfter !== undefined) {
      effect.redirected = !browserUrlsMatch(urlAfter, input.url);
    }
    effect.navigationOccurred = Boolean(urlBefore && urlAfter && urlBefore !== urlAfter);
    effect.newTabOpened = (after.browser?.pageCount ?? 1) > (before.browser?.pageCount ?? 1);
    effect.domChanged = Boolean(
      before.browser?.title !== after.browser?.title
      || effect.navigationOccurred
      || effect.newTabOpened,
    );
    effect.browserRevisionBefore = before.browser?.revision;
    effect.browserRevisionAfter = after.browser?.revision;
    if (before.browser?.revision !== after.browser?.revision) effect.domChanged = true;
    if (method === 'browser.download') {
      effect.downloadStarted = typeof dataRecord?.savedPath === 'string';
      if (dataRecord) effect.download = dataRecord as unknown as NonNullable<ActionReceipt['effect']>['download'];
    }
  }
  if (before.filesystem || after.filesystem || method.startsWith('fs.')) {
    const path = typeof input.path === 'string'
      ? input.path
      : typeof dataRecord?.path === 'string' ? dataRecord.path : undefined;
    if (path) effect.path = path;
    effect.existsBefore = before.filesystem?.exists;
    effect.existsAfter = after.filesystem?.exists;
    if (typeof dataRecord?.size === 'number') effect.bytesWritten = dataRecord.size;
    if (typeof dataRecord?.sha256 === 'string') effect.sha256 = dataRecord.sha256;
    effect.changed = effect.existsBefore !== effect.existsAfter || typeof dataRecord?.sha256 === 'string';
  }
  if (before.desktop || after.desktop) effect.changed = JSON.stringify(before.desktop) !== JSON.stringify(after.desktop);
  return effect;
}

function registerGuestTool<M extends GuestMethod>(
  registry: ToolRegistry,
  guest: GuestTransport,
  method: M,
): void {
  const inputSchema = guestMethodSchemas[method] as unknown as z.ZodType<GuestMethodParams[M]>;
  registry.register({
    name: method,
    description: TOOL_DESCRIPTIONS[method] ?? `Invoke guest method ${method}.`,
    inputSchema,
    execute: async (input, context) => {
      const startedAt = new Date().toISOString();
      const before = await boundarySnapshot(guest, method, input as Record<string, unknown>, context.signal);
      try {
        const data = await guest.request(method, input as GuestMethodParams[M], {
          signal: context.signal,
        });
        const after = await boundarySnapshot(guest, method, input as Record<string, unknown>, context.signal);
        const receipt: ActionReceipt = {
          id: `receipt-${crypto.randomUUID()}`,
          tool: method,
          ok: true,
          effect: receiptEffect(method, input as Record<string, unknown>, before, after, data),
          startedAt,
          completedAt: new Date().toISOString(),
        };
        return { ok: true, data, evidence: { receipt, before, after, data } };
      } catch (error) {
        const after = await boundarySnapshot(guest, method, input as Record<string, unknown>, context.signal);
        const receipt: ActionReceipt = {
          id: `receipt-${crypto.randomUUID()}`,
          tool: method,
          ok: false,
          effect: receiptEffect(method, input as Record<string, unknown>, before, after, undefined),
          startedAt,
          completedAt: new Date().toISOString(),
          error: recordError(error),
        };
        return { ...transportFailure(error), evidence: { receipt, before, after } };
      }
    },
  });
}

/** Build the semantic guest tools used by both the real and mock transports. */
export function createGuestToolRegistry(
  guest: GuestTransport,
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry(options);
  for (const method of Object.keys(guestMethodSchemas) as GuestMethod[]) {
    registerGuestTool(registry, guest, method);
  }
  return registry;
}

export const createDefaultToolRegistry = createGuestToolRegistry;
