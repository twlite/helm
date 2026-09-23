import type {
  BrowserRegionInspection,
  BrowserSearchPageResult,
  BrowserSnapshot,
  GuestMethod,
  WindowInfo,
} from '@helm/shared';

export type GuestMethodParams = {
  'guest.handshake': Record<string, never>;
  'fs.read': { path: string };
  'fs.write': { path: string; content: string };
  'fs.mkdir': { path: string };
  'fs.exists': { path: string };
  'fs.list': { path: string };
  'fs.stat': { path: string };
  'browser.navigate': { url: string };
  'browser.getState': Record<string, never>;
  'browser.snapshot': { maxRegions?: number };
  'browser.searchPage': { query: string; kinds?: import('@helm/shared').BrowserRegionKind[]; maxResults?: number };
  'browser.inspectRegion': { ref: string; format?: 'auto' | 'text' | 'table' | 'links'; maxChars?: number; offset?: number; limit?: number };
  'browser.extractText': { query: string; maxChars?: number };
  'browser.download': { ref?: string; url?: string };
  'browser.click': { ref?: string; x?: number; y?: number };
  'browser.type': { ref: string; text: string };
  'app.launch': { application: 'browser' | 'text-editor' | 'file-manager' };
  'app.openFile': {
    path: string;
    application?: 'text-editor' | 'file-manager';
  };
  'desktop.getState': Record<string, never>;
  'desktop.listWindows': Record<string, never>;
  'desktop.focusWindow': { application?: string; titleIncludes?: string };
  'desktop.hotkey': { keys: string[] };
  'desktop.type': { text: string };
  'desktop.click': { x: number; y: number };
  'desktop.screenshot': Record<string, never>;
};

export type GuestMethodResult = {
  'guest.handshake': {
    guestVersion: string;
    capabilities: GuestMethod[];
  };
  'fs.read': { path: string; content: string; size: number };
  'fs.write': { path: string; size: number; sha256?: string; existedBefore?: boolean };
  'fs.mkdir': { path: string; existedBefore: boolean };
  'fs.exists': { path: string; exists: boolean };
  'fs.list': { path: string; entries: string[] };
  'fs.stat': {
    path: string;
    exists: boolean;
    type: 'file' | 'directory' | 'other' | 'missing';
    size: number;
  };
  'browser.navigate': { url: string; title: string; loading: boolean; pageCount: number; revision: number };
  'browser.getState': {
    ready: boolean;
    visible: true;
    url: string;
    title: string;
    loading: boolean;
    pageCount: number;
    revision: number;
  };
  'browser.snapshot': BrowserSnapshot;
  'browser.searchPage': BrowserSearchPageResult;
  'browser.inspectRegion': BrowserRegionInspection;
  'browser.extractText': { url: string; title: string; query: string; text: string; truncated: boolean; matches: number };
  'browser.download': {
    sourceUrl: string;
    finalUrl?: string;
    suggestedFilename?: string;
    savedPath?: string;
    size?: number;
    context?: string;
    startedAt: string;
  };
  'browser.click': { ref?: string; x?: number; y?: number; clicked: boolean };
  'browser.type': { ref: string; text: string; typed: boolean };
  'app.launch': { application: 'browser' | 'text-editor' | 'file-manager'; title: string };
  'app.openFile': {
    path: string;
    application: 'text-editor' | 'file-manager';
    title: string;
  };
  'desktop.getState': {
    focusedWindow?: WindowInfo;
    windows: WindowInfo[];
    screenshotId?: string;
  };
  'desktop.listWindows': { windows: WindowInfo[] };
  'desktop.focusWindow': { focusedWindow: WindowInfo; windows: WindowInfo[] };
  'desktop.hotkey': { keys: string[]; sent: boolean };
  'desktop.type': { text: string; typed: boolean };
  'desktop.click': { x: number; y: number; clicked: boolean };
  'desktop.screenshot': { screenshotId: string; image: string };
};

export interface GuestRequestOptions {
  signal?: AbortSignal;
}

export class GuestTransportError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'GuestTransportError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Host-side boundary for the guest RPC protocol.
 *
 * The interface deliberately exposes only typed guest methods. In particular,
 * it has no arbitrary command or shell operation.
 */
export interface GuestTransport {
  request<M extends GuestMethod>(
    method: M,
    params: GuestMethodParams[M],
    options?: GuestRequestOptions,
  ): Promise<GuestMethodResult[M]>;
}
