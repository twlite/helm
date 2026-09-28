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
  'guest.handshake': 'Check the loaded guest build identity, protocol contract, server process ID, and capabilities.',
  'fs.read': 'Read a UTF-8 file inside the allowed guest filesystem root.',
  'fs.write': 'Write UTF-8 text inside the guest filesystem root. Use {path, content} for model-authored text. Use {path, sourceRef, format?} to serialize a durable browser.read block ref or documentRef; format selects text, markdown, json, or csv and applies only to sourceRef. No extra browser.read is needed before writing a returned ref.',
  'fs.mkdir': 'Create a directory inside the allowed guest filesystem root.',
  'fs.exists': 'Check whether a guest filesystem path exists.',
  'fs.list': 'List immediate entries inside an allowed guest directory.',
  'fs.stat': 'Inspect whether a guest filesystem path exists and its type.',
  'browser.navigate': 'Navigate the visible guest browser to a valid HTTP or HTTPS URL. User-provided URLs may be opened directly.',
  'browser.getState': 'Read the visible browser URL, title, loading state, page count, and current DOM revision without reading page text.',
  'browser.snapshot': 'Return a bounded semantic outline of the current page and its visible interactive elements.',
  'browser.read': 'Read bounded structured semantic content from the current page. query is natural-language content relevance text, not a CSS selector; use browser.query for DOM/CSS inspection. A query returns matching content and may return no blocks when nothing matches. Use mode readable for compact ranked blocks or mode document for a broader DOM-ordered selection; use blockTypes (for example table) to select a structured block class. Page reads accept maxBlocks/maxChars; ref reads accept offset/limit/maxChars for pagination. Results include durable block refs and, when multiple blocks are selected, a documentRef that fs.write can serialize losslessly with sourceRef.',
  'browser.query': 'Inspect a bounded set of current DOM elements by CSS selector, text, role, or name. Returns compact metadata and revision-bound element refs; observed links include navigation refs. Use it to inspect rendered rows or controls when semantic extraction is incomplete.',
  'browser.evaluate': 'Evaluate a JavaScript expression inside the current browser page and return JSON-serializable data (maximum 64 KB; bounded by the browser operation timeout). It runs only in page context and has no guest or host filesystem, process, environment, or host API access.',
  'browser.findPage': 'Find and rank content on the current page. This is page-local search and does not search the web; results include typed current-page refs.',
  'browser.webSearch': 'Search the public web with DuckDuckGo in Helm\'s local browser. Returns observed result records with exact hrefs and navigation refs. You may refine and search again when needed.',
  'browser.open': 'Open a destination represented by an observed browser navigation or content ref. Use linkIndex for a block containing multiple links.',
  'browser.inspectRegion': 'Inspect one current page region as bounded text, structured table rows, or local links. Large tables support offset and limit pagination.',
  'browser.download': 'Start and record a browser download from a semantic element or URL.',
  'browser.click': 'Click a semantic browser element or desktop coordinate fallback.',
  'browser.type': 'Type into a semantic browser element.',
  'app.launch': 'Launch an allowlisted guest application when the user explicitly asks to start the application without opening a file. For an existing file, use app.openFile.',
  'app.openFile': 'Open an existing guest file in an allowlisted application. Checks that the path is a regular file before application side effects, launches the selected application if needed, and returns FILE_NOT_FOUND when the path does not exist.',
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
    'browser.read', 'browser.snapshot', 'browser.findPage', 'browser.inspectRegion', 'browser.getState', 'browser.query', 'browser.evaluate',
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
    } else if (method === 'browser.webSearch' && typeof dataRecord?.requestedUrl === 'string') {
      effect.requestedUrl = dataRecord.requestedUrl;
    }
    const urlBefore = before.browser?.url;
    const urlAfter = after.browser?.url ?? (typeof dataRecord?.url === 'string' ? dataRecord.url : undefined);
    effect.urlBefore = urlBefore;
    effect.urlAfter = urlAfter;
    if ((method === 'browser.navigate' && typeof input.url === 'string') || method === 'browser.webSearch') {
      const requestedUrl = method === 'browser.webSearch' && typeof dataRecord?.requestedUrl === 'string'
        ? dataRecord.requestedUrl
        : typeof input.url === 'string' ? input.url : undefined;
      if (requestedUrl && urlAfter !== undefined) effect.redirected = !browserUrlsMatch(urlAfter, requestedUrl);
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
    const path = typeof dataRecord?.path === 'string'
      ? dataRecord.path
      : typeof input.path === 'string' ? input.path : undefined;
    if (path) effect.path = path;
    effect.existsBefore = before.filesystem?.exists;
    effect.existsAfter = after.filesystem?.exists;
    if (typeof dataRecord?.size === 'number') effect.bytesWritten = dataRecord.size;
    if (typeof dataRecord?.existedBefore === 'boolean') effect.existsBefore = dataRecord.existedBefore;
    if (typeof dataRecord?.beforeSha256 === 'string') effect.beforeSha256 = dataRecord.beforeSha256;
    if (typeof dataRecord?.sha256 === 'string') effect.sha256 = dataRecord.sha256;
    if (typeof dataRecord?.changed === 'boolean') effect.changed = dataRecord.changed;
    else effect.changed = effect.existsBefore !== effect.existsAfter;
    if (method === 'fs.write' && typeof dataRecord?.sha256 === 'string') effect.writePerformed = true;
  }
  if (method === 'app.openFile') {
    const path = typeof dataRecord?.path === 'string'
      ? dataRecord.path
      : typeof input.path === 'string' ? input.path : undefined;
    if (path) effect.path = path;
    const application = typeof dataRecord?.application === 'string'
      ? dataRecord.application
      : typeof input.application === 'string' ? input.application : undefined;
    if (application) effect.application = application;
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
