import { posix } from 'node:path';

import type { GuestMethod, WindowInfo } from '@helm/shared';
import { guestMethodSchemas } from '@helm/shared';
import type {
  GuestMethodParams,
  GuestMethodResult,
  GuestRequestOptions,
  GuestTransport,
} from './guest-transport';
import { GuestTransportError } from './guest-transport';

export const MOCK_GUEST_ROOT = '/home/helm';
export const MOCK_WORKSPACE_ROOT = '/home/helm/workspace';
export const DEMO_PAGE_PATH = '/home/helm/fixtures/demo.html';
export const DEMO_PAGE_URL = `file://${DEMO_PAGE_PATH}`;
export const DEMO_PAGE_TITLE = 'Helm deterministic demo';
export const DEMO_PAGE_TEXT = 'Helm deterministic demo content.';

export const DEMO_PAGE_HTML = `<!doctype html>
<html>
  <head><title>${DEMO_PAGE_TITLE}</title></head>
  <body>
    <main>
      <h1>${DEMO_PAGE_TITLE}</h1>
      <p>${DEMO_PAGE_TEXT}</p>
    </main>
  </body>
</html>`;

const EMPTY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

export interface MockGuestOptions {
  initialFiles?: Record<string, string>;
  delayMs?: number;
}

interface MockBrowserElement {
  ref: string;
  role: string;
  name?: string;
  value?: string;
}

interface MockBrowserState {
  url?: string;
  title?: string;
  loaded: boolean;
  text: string;
  elements: MockBrowserElement[];
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function readableText(html: string): string {
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? html;
  return decodeHtml(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

function pageTitle(html: string, fallback: string): string {
  return decodeHtml(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? fallback);
}

function parseElements(html: string): MockBrowserElement[] {
  const elements: MockBrowserElement[] = [];
  const pattern = /<(button|a|input|textarea|select)\b([^>]*)>([\s\S]*?)<\/\1>|<(input|textarea|select)\b([^>]*)\/?\s*>/gi;
  let index = 1;
  for (const match of html.matchAll(pattern)) {
    const role = (match[1] ?? match[4] ?? 'element').toLowerCase();
    const attributes = match[2] ?? match[5] ?? '';
    const body = match[3] ?? '';
    const name =
      (attributes.match(/(?:aria-label|placeholder|name)\s*=\s*["']([^"']+)["']/i)?.[1] ??
        readableText(body)) ||
      undefined;
    elements.push({ ref: `e${index}`, role, name });
    index += 1;
  }
  return elements;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1) || path;
}

function assertAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new GuestTransportError('CANCELLED', 'Guest request was cancelled');
  }
}

function normalizeGuestPath(input: string): string {
  if (!input || input.includes('\0')) {
    throw new GuestTransportError('INVALID_PATH', 'Guest path is invalid');
  }
  const normalized = posix.normalize(input);
  if (normalized !== MOCK_GUEST_ROOT && !normalized.startsWith(`${MOCK_GUEST_ROOT}/`)) {
    throw new GuestTransportError('PATH_OUTSIDE_ALLOWED_ROOT', 'Guest path is outside /home/helm');
  }
  return normalized;
}

function pathFromFileUrl(url: string): string | undefined {
  if (!url.startsWith('file://')) return undefined;
  try {
    return normalizeGuestPath(decodeURIComponent(new URL(url).pathname));
  } catch (error) {
    if (error instanceof GuestTransportError) throw error;
    throw new GuestTransportError('INVALID_URL', 'The file URL is invalid');
  }
}

function isToolMethod(method: GuestMethod): method is GuestMethod {
  return Boolean(method);
}

/**
 * A deterministic in-memory guest. It models the semantic state that the real
 * guest RPC service will expose, without launching a VM, browser, or desktop.
 */
export class MockGuestTransport implements GuestTransport {
  private readonly files = new Map<string, string>();
  private readonly delayMs: number;
  private readonly windows = new Map<string, WindowInfo>();
  private browser: MockBrowserState = {
    loaded: false,
    text: '',
    elements: [],
  };
  private screenshotCounter = 0;
  private screenshotId?: string;

  constructor(options: MockGuestOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    this.files.set(DEMO_PAGE_PATH, DEMO_PAGE_HTML);
    for (const [path, content] of Object.entries(options.initialFiles ?? {})) {
      this.setFile(path, content);
    }
  }

  getFile(path: string): string | undefined {
    return this.files.get(normalizeGuestPath(path));
  }

  setFile(path: string, content: string): void {
    this.files.set(normalizeGuestPath(path), content);
  }

  hasFile(path: string): boolean {
    return this.files.has(normalizeGuestPath(path));
  }

  get browserState(): Readonly<MockBrowserState> {
    return {
      ...this.browser,
      elements: this.browser.elements.map(element => ({ ...element })),
    };
  }

  get desktopWindows(): WindowInfo[] {
    return [...this.windows.values()].map(window => ({ ...window }));
  }

  reset(): void {
    this.files.clear();
    this.files.set(DEMO_PAGE_PATH, DEMO_PAGE_HTML);
    this.windows.clear();
    this.browser = { loaded: false, text: '', elements: [] };
    this.screenshotCounter = 0;
    this.screenshotId = undefined;
  }

  async request<M extends GuestMethod>(
    method: M,
    params: GuestMethodParams[M],
    options: GuestRequestOptions = {},
  ): Promise<GuestMethodResult[M]> {
    assertAbort(options.signal);
    if (this.delayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          reject(new GuestTransportError('CANCELLED', 'Guest request was cancelled'));
        };
        options.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    assertAbort(options.signal);

    const schema = guestMethodSchemas[method];
    if (schema) schema.parse(params);
    if (!isToolMethod(method)) {
      throw new GuestTransportError('UNKNOWN_METHOD', `Unknown guest method: ${String(method)}`);
    }

    const result = await this.handle(method, params);
    assertAbort(options.signal);
    return result as GuestMethodResult[M];
  }

  private async handle<M extends GuestMethod>(
    method: M,
    params: GuestMethodParams[M],
  ): Promise<GuestMethodResult[M]> {
    switch (method) {
      case 'guest.handshake':
        return {
          guestVersion: 'mock-1',
          capabilities: Object.keys(guestMethodSchemas) as GuestMethod[],
        } as GuestMethodResult[M];
      case 'fs.read': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.read']).path);
        const content = this.files.get(path);
        if (content === undefined) {
          throw new GuestTransportError('FILE_NOT_FOUND', `File does not exist: ${path}`);
        }
        return { path, content, size: content.length } as GuestMethodResult[M];
      }
      case 'fs.write': {
        const input = params as GuestMethodParams['fs.write'];
        const path = normalizeGuestPath(input.path);
        this.files.set(path, input.content);
        return { path, size: input.content.length } as GuestMethodResult[M];
      }
      case 'fs.exists': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.exists']).path);
        return { path, exists: this.files.has(path) } as GuestMethodResult[M];
      }
      case 'fs.list': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.list']).path);
        const prefix = path === MOCK_GUEST_ROOT ? `${path}/` : `${path}/`;
        const entries = new Set<string>();
        for (const file of this.files.keys()) {
          if (!file.startsWith(prefix)) continue;
          const remainder = file.slice(prefix.length);
          entries.add(remainder.split('/')[0]);
        }
        return { path, entries: [...entries].sort() } as GuestMethodResult[M];
      }
      case 'fs.stat': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.stat']).path);
        if (this.files.has(path)) {
          const content = this.files.get(path) ?? '';
          return {
            path,
            exists: true,
            type: 'file',
            size: content.length,
          } as GuestMethodResult[M];
        }
        const isDirectory =
          path === MOCK_GUEST_ROOT ||
          [...this.files.keys()].some(file => file.startsWith(`${path}/`));
        return {
          path,
          exists: isDirectory,
          type: isDirectory ? 'directory' : 'missing',
          size: 0,
        } as GuestMethodResult[M];
      }
      case 'browser.navigate': {
        const url = (params as GuestMethodParams['browser.navigate']).url;
        const path = pathFromFileUrl(url);
        const html = path ? this.files.get(path) : undefined;
        if (path && html === undefined) {
          throw new GuestTransportError('PAGE_NOT_FOUND', `Page does not exist: ${path}`);
        }
        const document = html ?? `<html><body>Mock page for ${url}</body></html>`;
        const title = pageTitle(document, 'Mock page');
        this.browser = {
          url,
          title,
          loaded: true,
          text: readableText(document),
          elements: parseElements(document),
        };
        this.upsertWindow('browser', 'Chromium', title, true);
        return { url, title, loaded: true } as GuestMethodResult[M];
      }
      case 'browser.getState':
        return {
          url: this.browser.url,
          title: this.browser.title,
          loaded: this.browser.loaded,
        } as GuestMethodResult[M];
      case 'browser.snapshot':
        return {
          url: this.browser.url,
          title: this.browser.title,
          elements: this.browser.elements.map(element => ({ ...element })),
        } as GuestMethodResult[M];
      case 'browser.extractText': {
        if (!this.browser.loaded || !this.browser.url) {
          throw new GuestTransportError('BROWSER_NOT_READY', 'Navigate the browser before extracting text');
        }
        return {
          url: this.browser.url,
          title: this.browser.title ?? '',
          text: this.browser.text,
        } as GuestMethodResult[M];
      }
      case 'browser.click': {
        const input = params as GuestMethodParams['browser.click'];
        if (input.ref && !this.browser.elements.some(element => element.ref === input.ref)) {
          throw new GuestTransportError('ELEMENT_NOT_FOUND', `Browser element does not exist: ${input.ref}`);
        }
        return { ...input, clicked: true } as GuestMethodResult[M];
      }
      case 'browser.type': {
        const input = params as GuestMethodParams['browser.type'];
        if (!this.browser.elements.some(element => element.ref === input.ref)) {
          throw new GuestTransportError('ELEMENT_NOT_FOUND', `Browser element does not exist: ${input.ref}`);
        }
        const element = this.browser.elements.find(candidate => candidate.ref === input.ref);
        if (element) element.value = input.text;
        return { ref: input.ref, text: input.text, typed: true } as GuestMethodResult[M];
      }
      case 'app.launch': {
        const application = (params as GuestMethodParams['app.launch']).application;
        const title = this.launchApplication(application);
        return { application, title } as GuestMethodResult[M];
      }
      case 'app.openFile': {
        const input = params as GuestMethodParams['app.openFile'];
        const path = normalizeGuestPath(input.path);
        if (!this.files.has(path)) {
          throw new GuestTransportError('FILE_NOT_FOUND', `File does not exist: ${path}`);
        }
        const application = input.application ?? 'text-editor';
        const title = this.openFileWindow(application, path);
        return { path, application, title } as GuestMethodResult[M];
      }
      case 'desktop.getState':
        return this.desktopState() as GuestMethodResult[M];
      case 'desktop.listWindows':
        return { windows: this.desktopWindows } as GuestMethodResult[M];
      case 'desktop.focusWindow': {
        const input = params as GuestMethodParams['desktop.focusWindow'];
        const target = this.desktopWindows.find(window => this.matchesWindow(window, input));
        if (!target) {
          throw new GuestTransportError('WINDOW_NOT_FOUND', 'No matching desktop window exists');
        }
        this.focusWindow(target.id);
        return this.desktopState() as GuestMethodResult[M];
      }
      case 'desktop.hotkey': {
        const keys = (params as GuestMethodParams['desktop.hotkey']).keys;
        return { keys, sent: true } as GuestMethodResult[M];
      }
      case 'desktop.type': {
        const text = (params as GuestMethodParams['desktop.type']).text;
        return { text, typed: true } as GuestMethodResult[M];
      }
      case 'desktop.click': {
        const { x, y } = params as GuestMethodParams['desktop.click'];
        return { x, y, clicked: true } as GuestMethodResult[M];
      }
      case 'desktop.screenshot': {
        this.screenshotCounter += 1;
        this.screenshotId = `mock-screenshot-${this.screenshotCounter}`;
        return {
          screenshotId: this.screenshotId,
          image: EMPTY_PNG_DATA_URL,
        } as GuestMethodResult[M];
      }
      default:
        throw new GuestTransportError('UNKNOWN_METHOD', `Unknown guest method: ${String(method)}`);
    }
  }

  private upsertWindow(application: string, id: string, title: string, focused: boolean): void {
    this.windows.set(application, { id, application, title, focused });
    if (focused) this.focusWindow(application);
  }

  private launchApplication(application: 'browser' | 'text-editor' | 'file-manager'): string {
    const metadata = {
      browser: { id: 'Chromium', title: this.browser.title ?? 'Chromium' },
      'text-editor': { id: 'Text Editor', title: 'Text Editor' },
      'file-manager': { id: 'File Manager', title: 'File Manager' },
    }[application];
    this.upsertWindow(application, metadata.id, metadata.title, true);
    return metadata.title;
  }

  private openFileWindow(application: 'text-editor' | 'file-manager', path: string): string {
    const title = `${basename(path)} — ${application === 'text-editor' ? 'Text Editor' : 'File Manager'}`;
    this.upsertWindow(application, application === 'text-editor' ? 'Text Editor' : 'File Manager', title, true);
    return title;
  }

  private focusWindow(idOrApplication: string): void {
    for (const [key, window] of this.windows) {
      this.windows.set(key, { ...window, focused: window.id === idOrApplication || key === idOrApplication });
    }
  }

  private matchesWindow(
    window: WindowInfo,
    filter: { application?: string; titleIncludes?: string },
  ): boolean {
    return (
      (!filter.application || window.application === filter.application) &&
      (!filter.titleIncludes || window.title.includes(filter.titleIncludes))
    );
  }

  private desktopState(): GuestMethodResult['desktop.getState'] {
    const windows = this.desktopWindows;
    return {
      focusedWindow: windows.find(window => window.focused),
      windows,
      screenshotId: this.screenshotId,
    };
  }
}

export { normalizeGuestPath };
