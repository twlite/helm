import { posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type {
  BrowserContentBlock,
  BrowserContentFormat,
  BrowserContentSummary,
  BrowserRegionKind,
  BrowserReadMode,
  GuestMethod,
  WindowInfo,
} from '@helm/shared';
import { rankBrowserContentBlocks, type IndexedBrowserRegion } from '@helm/shared';
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
  pages?: Record<string, string>;
  /** Deterministic HTTP redirect map used by browser navigation tests. */
  redirects?: Record<string, string>;
  /** Deterministic failures for selected browser navigation URLs. */
  navigationFailures?: Record<string, string>;
  delayMs?: number;
  downloads?: Record<string, { finalUrl?: string; filename: string; content?: string; context?: string }>;
}

interface MockBrowserElement {
  ref: string;
  role: string;
  name?: string;
  value?: string;
  text?: string;
  enabled?: boolean;
  href?: string;
  checked?: boolean;
  selected?: boolean;
}

interface MockBrowserState {
  url?: string;
  title?: string;
  loaded: boolean;
  text: string;
  elements: MockBrowserElement[];
  pageCount: number;
  revision: number;
  html?: string;
  regions: Array<IndexedBrowserRegion & { tableRows?: string[][]; links?: Array<{ text: string; href: string }>; listItem?: boolean }>;
}

interface MockContentReference {
  block: BrowserContentBlock;
  revision: number;
  url: string;
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

function mockReadablePageText(html: string, mode: 'readable' | 'document'): string {
  let source = html;
  if (mode === 'readable') {
    source = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/iu)?.[1]
      ?? html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/iu)?.[1]
      ?? html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/iu)?.[1]
      ?? html;
    source = source.replace(/<(nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/giu, ' ');
  }
  return readableText(source);
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

function mockRegionKind(tag: string): BrowserRegionKind {
  if (/^h[1-6]$/iu.test(tag)) return 'heading';
  if (tag === 'article') return 'article';
  if (tag === 'table') return 'table';
  if (tag === 'ul' || tag === 'ol' || tag === 'li') return 'list';
  if (tag === 'form') return 'form';
  if (tag === 'nav') return 'navigation';
  if (tag === 'footer') return 'footer';
  if (tag === 'aside') return 'aside';
  if (tag === 'main' || tag === 'section') return 'section';
  return 'text';
}

function mockRegions(html: string, revision: number) {
  const regions: Array<IndexedBrowserRegion & { tableRows?: string[][]; links?: Array<{ text: string; href: string }>; listItem?: boolean }> = [];
  const tags = ['main', 'article', 'section', 'table', 'ul', 'ol', 'li', 'form', 'nav', 'aside', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'pre', 'dl'];
  const candidates: Array<{ tag: string; body: string; offset: number }> = [];
  for (const tag of tags) {
    const matcher = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'giu');
    for (const match of html.matchAll(matcher)) {
      candidates.push({ tag, body: match[1] ?? '', offset: match.index ?? 0 });
    }
  }
  candidates.sort((left, right) => left.offset - right.offset);
  let heading: string | undefined;
  for (const candidate of candidates) {
    const tag = candidate.tag;
    const body = candidate.body;
    const kind = mockRegionKind(tag);
    const text = readableText(body);
    if (!text) continue;
    if (kind === 'heading') heading = text.slice(0, 160);
    const rowMatches = tag === 'table' ? [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/giu)] : [];
    const parsedRows = rowMatches.map(row => [...(row[1] ?? '').matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/giu)]
      .map(cell => readableText(cell[1] ?? '')));
    const headerIndex = parsedRows.findIndex((_, index) => /<th\b/iu.test(rowMatches[index]?.[1] ?? ''));
    const actualHeaderIndex = headerIndex >= 0 ? headerIndex : parsedRows.length > 0 ? 0 : -1;
    const tableHeaders = actualHeaderIndex >= 0 ? parsedRows[actualHeaderIndex] : undefined;
    const tableRows = parsedRows.filter((_, index) => index !== actualHeaderIndex && parsedRows[index]!.length > 0);
    const candidateIndex = regions.length;
    const previewSource = kind === 'table'
      ? `${tableHeaders?.join(' ') ?? ''} ${tableRows[0]?.join(' ') ?? ''}`
      : text;
    const region: IndexedBrowserRegion & { tableRows?: string[][]; links?: Array<{ text: string; href: string }>; listItem?: boolean } = {
      ref: `r${revision}-${candidateIndex + 1}`,
      kind,
      ...(kind === 'heading' ? { heading: text.slice(0, 160) } : heading ? { heading } : {}),
      preview: previewSource.replace(/\s+/gu, ' ').trim().slice(0, 180),
      searchText: text,
      ...(tableHeaders ? { tableHeaders } : {}),
      ...(kind === 'table' ? { rowCount: tableRows.length, columnCount: Math.max(0, ...parsedRows.map(row => row.length)), tableRows } : {}),
      ...(tag === 'li' ? { listItem: true } : {}),
      domOrder: candidateIndex,
      ...(kind === 'navigation' || kind === 'article' || kind === 'section' || kind === 'list' || kind === 'text'
        ? { links: [...body.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/giu)]
          .map(link => ({ text: readableText(link[2] ?? ''), href: link[1] ?? '' })) }
        : {}),
    };
    regions.push(region);
  }
  if (regions.length === 0) {
    const text = readableText(html);
    if (text) regions.push({ ref: `r${revision}-1`, kind: 'text', preview: text.slice(0, 180), searchText: text, domOrder: 0 });
  }
  return regions;
}

function mockOutlinePriority(kind: BrowserRegionKind): number {
  if (kind === 'table') return 0;
  if (kind === 'heading') return 1;
  if (kind === 'article' || kind === 'section') return 2;
  if (kind === 'form' || kind === 'list') return 3;
  if (kind === 'navigation' || kind === 'aside' || kind === 'footer') return 4;
  return 5;
}

function boundedTable(
  region: MockBrowserState['regions'][number],
  maxChars: number,
  offset = 0,
  limit = 50,
) {
  const sourceColumns = region.tableHeaders ?? [];
  const sourceRows = region.tableRows ?? [];
  const maxColumns = Math.max(1, Math.min(80, Math.floor(maxChars / 100)));
  const maxHeaderChars = Math.max(16, Math.min(128, Math.floor(maxChars / (maxColumns * 2))));
  const columns = sourceColumns.slice(0, maxColumns).map(value => value.slice(0, maxHeaderChars));
  const maxCellChars = Math.max(16, Math.min(256, Math.floor(maxChars * 0.4 / Math.max(1, columns.length))));
  let chars = JSON.stringify(columns).length;
  const rows: string[][] = [];
  for (const sourceRow of sourceRows.slice(offset, offset + limit)) {
    const row = sourceRow.slice(0, columns.length).map(value => value.slice(0, maxCellChars));
    const size = JSON.stringify(row).length + 1;
    if (chars + size > maxChars) break;
    rows.push(row);
    chars += size;
  }
  return {
    columns,
    rows,
    rowCount: sourceRows.length,
    returnedRowCount: rows.length,
    offset,
    truncated: columns.length < sourceColumns.length || offset > 0 || offset + rows.length < sourceRows.length,
  };
}

function mockContentBlocks(
  browser: MockBrowserState,
  contentReferences: Map<string, MockContentReference>,
  contentSessionId: string,
): BrowserContentBlock[] {
  const isDuckDuckGoResults = (() => {
    try {
      const url = new URL(browser.url ?? '');
      return url.hostname === 'duckduckgo.com' && (url.searchParams.has('q') || url.searchParams.has('query'));
    } catch {
      return false;
    }
  })();
  const blocks = browser.regions.map((region, index): BrowserContentBlock => {
    const ref = `c${browser.revision}-${contentSessionId}-${index + 1}`;
    const observedLinks = (region.links ?? []).flatMap(link => {
      try {
        const target = new URL(link.href, browser.url);
        if (!['http:', 'https:'].includes(target.protocol)) return [];
        const isDuckDuckGo = target.hostname === 'duckduckgo.com' || target.hostname.endsWith('.duckduckgo.com');
        const wrapped = isDuckDuckGo
          ? target.searchParams.get('uddg') ?? target.searchParams.get('url')
          : undefined;
        const destination = wrapped ? new URL(wrapped) : target;
        if (!['http:', 'https:'].includes(destination.protocol)) return [];
        return [{ text: link.text, href: destination.href }];
      } catch {
        return [];
      }
    });
    const searchResultLink = isDuckDuckGoResults
      && (region.kind === 'article' || (region.kind === 'list' && region.listItem))
      && observedLinks.length === 1
      ? observedLinks[0]
      : undefined;
    if (searchResultLink) {
      const snippet = region.searchText.replace(searchResultLink.text, ' ').replace(/\s+/gu, ' ').trim();
      return {
        ref,
        type: 'search_result',
        title: searchResultLink.text,
        href: searchResultLink.href,
        ...(snippet ? { snippet } : {}),
        text: [searchResultLink.text, snippet].filter(Boolean).join('\n'),
        source: { extractor: 'dom' },
        role: 'search-result',
        importance: 0.96,
        boilerplate: false,
      };
    }
    if (region.kind === 'table') {
      return {
        ref,
        type: 'table',
        ...(region.heading ? { heading: region.heading, headingPath: [region.heading] } : {}),
        source: { extractor: 'dom' },
        role: 'table',
        importance: 0.98,
        boilerplate: false,
        columns: region.tableHeaders ?? [],
        rows: region.tableRows ?? [],
        rowCount: region.rowCount ?? region.tableRows?.length ?? 0,
        columnCount: region.columnCount ?? region.tableHeaders?.length ?? 0,
      };
    }
    if (region.kind === 'navigation' || region.kind === 'footer' || region.kind === 'aside') {
      return {
        ref,
        type: 'navigation',
        heading: region.heading,
        source: { extractor: 'dom' },
        role: region.kind,
        importance: 0.1,
        boilerplate: true,
        text: region.searchText,
        links: observedLinks,
      };
    }
    if (region.kind === 'heading') {
      return {
        ref,
        type: 'heading',
        heading: region.heading ?? region.searchText,
        headingPath: region.heading ? [region.heading] : [region.searchText],
        source: { extractor: 'dom' },
        importance: 0.7,
        boilerplate: false,
        text: region.searchText,
      };
    }
    return {
      ref,
      type: region.kind === 'list' ? 'list' : region.kind === 'form' ? 'form' : 'text',
      ...(region.heading ? { heading: region.heading, headingPath: [region.heading] } : {}),
      source: { extractor: 'dom' },
      importance: region.kind === 'article' ? 0.84 : region.kind === 'form' ? 0.92 : 0.68,
      boilerplate: false,
      text: region.searchText,
      ...(region.links ? { links: observedLinks } : {}),
      ...(region.tableRows ? { rows: region.tableRows } : {}),
    };
  });
  for (const block of blocks) {
    contentReferences.set(block.ref, { block, revision: browser.revision, url: browser.url ?? '' });
  }
  return blocks;
}

function mockBlockText(block: BrowserContentBlock): string {
  if (block.type === 'table') {
    return [block.headingPath?.join(' / ') || block.heading || block.caption, block.columns?.join(' | '), ...(block.rows ?? []).map(row => row.join(' | '))]
      .filter(Boolean).join('\n');
  }
  if (block.type === 'list') return (block.items ?? []).map((item, index) => block.ordered ? `${index + 1}. ${item}` : `- ${item}`).join('\n');
  if (block.type === 'definition') return (block.definitions ?? []).map(item => `${item.term}: ${item.definition}`).join('\n');
  if (block.type === 'form') return (block.fields ?? []).map(field => `${field.label || field.type || 'Field'}${field.required ? ' (required)' : ''}${field.value ? `: ${field.value}` : ''}`).join('\n');
  if (block.type === 'search_result') return [block.title, block.href, block.snippet].filter(Boolean).join('\n');
  if (block.type === 'navigation') {
    const links = (block.links ?? []).map(link => `${link.text || link.href}${link.text ? ` (${link.href})` : ''}`);
    return [block.text, ...links].filter(Boolean).join('\n');
  }
  return block.text ?? '';
}

function mockSerializeContent(block: BrowserContentBlock, format: BrowserContentFormat): string {
  if (format === 'json') return `${JSON.stringify({
    type: block.type,
    heading: block.heading,
    headingPath: block.headingPath,
    ...(block.caption ? { caption: block.caption } : {}),
    ...(block.columns ? { columns: block.columns } : {}),
    ...(block.rows ? { rows: block.rows } : {}),
    ...(block.items ? { items: block.items } : {}),
    ...(block.fields ? { fields: block.fields } : {}),
    ...(block.definitions ? { definitions: block.definitions } : {}),
    ...(block.links ? { links: block.links } : {}),
    ...(block.title ? { title: block.title } : {}),
    ...(block.href ? { href: block.href } : {}),
    ...(block.snippet ? { snippet: block.snippet } : {}),
    ...(block.language ? { language: block.language } : {}),
    ...(block.text ? { text: block.text } : {}),
    ...(block.cellSpans ? { cellSpans: block.cellSpans } : {}),
  }, null, 2)}\n`;
  if (format === 'csv') {
    if (block.type !== 'table' || !block.columns || !block.rows) {
      throw new GuestTransportError('UNSUPPORTED_CONTENT_FORMAT', 'CSV export requires a table content ref.');
    }
    const cell = (value: string): string => /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
    return [block.columns.map(cell).join(','), ...block.rows.map(row => block.columns!.map((_, index) => cell(row[index] ?? '')).join(','))].join('\n') + '\n';
  }
  if (format === 'markdown' && block.type === 'table' && block.columns && block.rows) {
    const heading = block.headingPath?.join(' / ') || block.heading || block.caption;
    const escape = (value: string): string => value.replace(/\\/gu, '\\\\').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
    return [
      ...(heading ? [`## ${heading}`, ''] : []),
      `| ${block.columns.map(escape).join(' | ')} |`,
      `| ${block.columns.map(() => '---').join(' | ')} |`,
      ...block.rows.map(row => `| ${block.columns!.map((_, index) => escape(row[index] ?? '')).join(' | ')} |`),
    ].join('\n') + '\n';
  }
  const text = mockBlockText(block);
  if (format === 'markdown') {
    const heading = block.headingPath?.join(' / ') || block.heading;
    return `${heading ? `## ${heading}\n\n` : ''}${text}\n`;
  }
  const heading = block.type === 'heading' ? undefined : block.headingPath?.join(' / ') || block.heading;
  return `${heading ? `${heading}\n\n` : ''}${text}\n`;
}

function mockContentSummary(block: BrowserContentBlock, previewLimit: number, relevance?: number): BrowserContentSummary {
  const previewText = block.type === 'table'
    ? [block.caption || block.headingPath?.join(' / ') || block.heading, block.columns?.join(' | '), ...(block.rows ?? []).slice(0, 2).map(row => row.join(' | '))].filter(Boolean).join('\n')
    : block.type === 'search_result'
      ? [block.title, block.href, block.snippet].filter(Boolean).join('\n')
      : mockBlockText(block);
  return {
    ref: block.ref,
    type: block.type,
    ...(block.heading ? { heading: block.heading } : {}),
    ...(block.headingPath ? { headingPath: block.headingPath } : {}),
    ...(block.source ? { source: block.source } : {}),
    ...(block.role ? { role: block.role } : {}),
    ...(block.importance === undefined ? {} : { importance: block.importance }),
    ...(relevance === undefined ? block.relevance === undefined ? {} : { relevance: block.relevance } : { relevance }),
    ...(block.boilerplate === undefined ? {} : { boilerplate: block.boilerplate }),
    ...(block.caption ? { caption: block.caption } : {}),
    ...(block.columns ? { columns: block.columns } : {}),
    ...(block.type === 'table' ? { rows: (block.rows ?? []).slice(0, 2), rowCount: block.rowCount, columnCount: block.columnCount } : {}),
    ...(block.type === 'list' ? { items: (block.items ?? []).slice(0, 5), rowCount: block.rowCount } : {}),
    ...(block.links ? { links: block.links.slice(0, 8) } : {}),
    ...(block.title ? { title: block.title } : {}),
    ...(block.href ? { href: block.href } : {}),
    ...(block.snippet ? { snippet: block.snippet.slice(0, 400) } : {}),
    ...(block.language ? { language: block.language } : {}),
    ...(block.truncated === undefined ? {} : { truncated: block.truncated }),
    ...(previewText ? { preview: previewText.length > previewLimit ? `${previewText.slice(0, Math.max(1, previewLimit - 1))}…` : previewText } : {}),
  };
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
  const expanded = input === '~' ? MOCK_GUEST_ROOT : input.startsWith('~/') ? `${MOCK_GUEST_ROOT}/${input.slice(2)}` : input;
  const normalized = posix.isAbsolute(expanded)
    ? posix.normalize(expanded)
    : posix.resolve(MOCK_WORKSPACE_ROOT, expanded);
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
  private readonly directories = new Set<string>([MOCK_GUEST_ROOT]);
  private readonly pages: Record<string, string>;
  private readonly redirects: Record<string, string>;
  private readonly navigationFailures: Record<string, string>;
  private readonly delayMs: number;
  private readonly downloads: Record<string, { finalUrl?: string; filename: string; content?: string; context?: string }>;
  private readonly windows = new Map<string, WindowInfo>();
  private readonly contentReferences = new Map<string, MockContentReference>();
  private contentSessionId = randomUUID().replace(/-/gu, '').slice(0, 8);
  private browser: MockBrowserState = {
    loaded: false,
    text: '',
    elements: [],
    pageCount: 1,
    revision: 0,
    regions: [],
  };
  private screenshotCounter = 0;
  private screenshotId?: string;

  constructor(options: MockGuestOptions = {}) {
    this.delayMs = Math.max(0, options.delayMs ?? 0);
    this.pages = { ...(options.pages ?? {}) };
    this.redirects = { ...(options.redirects ?? {}) };
    this.navigationFailures = { ...(options.navigationFailures ?? {}) };
    this.downloads = options.downloads ?? {};
    this.files.set(DEMO_PAGE_PATH, DEMO_PAGE_HTML);
    this.addDirectoryParents(DEMO_PAGE_PATH);
    for (const [path, content] of Object.entries(options.initialFiles ?? {})) {
      this.setFile(path, content);
    }
  }

  getFile(path: string): string | undefined {
    return this.files.get(normalizeGuestPath(path));
  }

  setFile(path: string, content: string): void {
    const normalized = normalizeGuestPath(path);
    this.addDirectoryParents(normalized);
    this.files.set(normalized, content);
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
    this.directories.clear();
    this.directories.add(MOCK_GUEST_ROOT);
    this.files.set(DEMO_PAGE_PATH, DEMO_PAGE_HTML);
    this.addDirectoryParents(DEMO_PAGE_PATH);
    this.windows.clear();
    this.contentReferences.clear();
    this.contentSessionId = randomUUID().replace(/-/gu, '').slice(0, 8);
    this.browser = { loaded: false, text: '', elements: [], pageCount: 1, revision: 0, regions: [] };
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
        } as unknown as GuestMethodResult[M];
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
        let content = input.content;
        let sourceReference: MockContentReference | undefined;
        if (input.sourceRef) {
          sourceReference = this.contentReferences.get(input.sourceRef);
          if (!sourceReference || sourceReference.revision !== this.browser.revision || sourceReference.url !== this.browser.url) {
            throw new GuestTransportError('STALE_CONTENT_REF', `Browser content ref ${input.sourceRef} is unknown or stale. Read the current page again to obtain a fresh ref.`);
          }
          content = mockSerializeContent(sourceReference.block, input.format ?? 'text');
        }
        if (content === undefined) throw new GuestTransportError('INVALID_INPUT', 'Provide content or sourceRef.');
        const previous = this.files.get(path);
        const existedBefore = previous !== undefined;
        const beforeSha256 = previous === undefined ? undefined : createHash('sha256').update(previous, 'utf8').digest('hex');
        const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
        this.addDirectoryParents(path);
        this.files.set(path, content);
        return {
          path,
          size: Buffer.byteLength(content, 'utf8'),
          sha256,
          existedBefore,
          ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
          changed: !existedBefore || beforeSha256 !== sha256,
          ...(input.sourceRef && sourceReference ? {
            sourceRef: input.sourceRef,
            sourceType: sourceReference.block.type,
            sourceRevision: sourceReference.revision,
            sourceUrl: sourceReference.url,
            format: input.format ?? 'text',
          } : {}),
        } as GuestMethodResult[M];
      }
      case 'fs.mkdir': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.mkdir']).path);
        if (this.files.has(path)) {
          throw new GuestTransportError('NOT_A_DIRECTORY', `${path} is a file`);
        }
        const existedBefore = this.directories.has(path);
        this.addDirectoryParents(path);
        this.directories.add(path);
        return { path, existedBefore, changed: !existedBefore } as GuestMethodResult[M];
      }
      case 'fs.exists': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.exists']).path);
        return { path, exists: this.files.has(path) || this.directories.has(path) } as GuestMethodResult[M];
      }
      case 'fs.list': {
        const path = normalizeGuestPath((params as GuestMethodParams['fs.list']).path);
        const prefix = path === MOCK_GUEST_ROOT ? `${path}/` : `${path}/`;
        const entries = new Set<string>();
        for (const directory of this.directories) {
          if (!directory.startsWith(prefix)) continue;
          const remainder = directory.slice(prefix.length);
          if (remainder && !remainder.includes('/')) entries.add(remainder);
        }
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
        if (this.directories.has(path)) {
          return {
            path,
            exists: true,
            type: 'directory',
            size: 0,
          } as GuestMethodResult[M];
        }
        const isDirectory =
          path === MOCK_GUEST_ROOT ||
          this.directories.has(path) ||
          [...this.files.keys()].some(file => file.startsWith(`${path}/`));
        return {
          path,
          exists: isDirectory,
          type: isDirectory ? 'directory' : 'missing',
          size: 0,
        } as GuestMethodResult[M];
      }
      case 'browser.navigate': {
        const requestedUrl = (params as GuestMethodParams['browser.navigate']).url;
        return this.navigateMock(requestedUrl) as GuestMethodResult[M];
      }
      case 'browser.getState':
        return {
          ready: this.browser.loaded,
          visible: true,
          url: this.browser.url ?? 'about:blank',
          title: this.browser.title ?? '',
          loading: !this.browser.loaded,
          pageCount: this.browser.pageCount,
          revision: this.browser.revision,
        } as GuestMethodResult[M];
      case 'browser.snapshot': {
        const maxRegions = (params as GuestMethodParams['browser.snapshot']).maxRegions ?? 60;
        const outline = [...this.browser.regions]
          .sort((left, right) => mockOutlinePriority(left.kind) - mockOutlinePriority(right.kind) || left.domOrder - right.domOrder)
          .slice(0, maxRegions)
          .sort((left, right) => left.domOrder - right.domOrder)
          .map(region => ({
            ref: region.ref,
            kind: region.kind,
            ...(region.heading ? { heading: region.heading } : {}),
            ...(region.preview ? { preview: region.preview } : {}),
            ...(region.rowCount === undefined ? {} : { rowCount: region.rowCount }),
            ...(region.columnCount === undefined ? {} : { columnCount: region.columnCount }),
          }));
        return {
          url: this.browser.url,
          title: this.browser.title,
          pageCount: this.browser.pageCount,
          revision: this.browser.revision,
          regionCount: this.browser.regions.length,
          outlineTruncated: this.browser.regions.length > outline.length,
          outline,
          elements: this.browser.elements.slice(0, 80).map((element, index) => ({
            ...element,
            ref: `e${this.browser.revision}-${index + 1}`,
          })),
        } as GuestMethodResult[M];
      }
      case 'browser.read': {
        if (!this.browser.loaded || !this.browser.url) {
          throw new GuestTransportError('BROWSER_NOT_READY', 'Navigate the browser before reading page content');
        }
        const input = params as GuestMethodParams['browser.read'];
        const mode: BrowserReadMode = input.mode ?? 'readable';
        const maxChars = Math.max(1, Math.min(12_000, input.maxChars ?? 4_000));
        if (input.ref) {
          const reference = this.contentReferences.get(input.ref);
          if (!reference || reference.revision !== this.browser.revision || reference.url !== this.browser.url) {
            throw new GuestTransportError('STALE_CONTENT_REF', `Browser content ref ${input.ref} is unknown or stale.`);
          }
          const full = reference.block;
          const offset = Math.max(0, input.offset ?? 0);
          const limit = Math.max(1, Math.min(100, input.limit ?? 20));
          let block = full;
          let hasMore = false;
          if (full.type === 'table') {
            block = { ...full, rows: (full.rows ?? []).slice(offset, offset + limit) };
            hasMore = offset + (block.rows?.length ?? 0) < (full.rows?.length ?? 0);
          } else if (full.type === 'list') {
            const items: string[] = [];
            let itemChars = 0;
            for (const item of (full.items ?? []).slice(offset, offset + limit)) {
              const nextChars = JSON.stringify(item).length;
              if (items.length > 0 && itemChars + nextChars > maxChars) break;
              items.push(item);
              itemChars += nextChars;
            }
            block = { ...full, items };
            hasMore = offset + (block.items?.length ?? 0) < (full.items?.length ?? 0);
          } else if (['text', 'code', 'other'].includes(full.type) && full.text !== undefined) {
            block = { ...full, text: full.text.slice(offset, offset + maxChars) };
            hasMore = offset + (block.text?.length ?? 0) < full.text.length;
          }
          const summary = mockContentSummary(block, maxChars);
          const preview = summary.preview ?? '';
          if (block.type === 'table') {
            summary.rows = block.rows ?? [];
            summary.offset = offset;
            summary.returnedRowCount = summary.rows.length;
            hasMore = offset + summary.rows.length < (full.rows?.length ?? 0);
            if (hasMore) summary.nextOffset = offset + summary.rows.length;
          } else if (block.type === 'list') {
            summary.items = block.items ?? [];
            summary.offset = offset;
            summary.returnedRowCount = summary.items.length;
            if (hasMore) summary.nextOffset = offset + summary.items.length;
          } else if (['text', 'code', 'other'].includes(block.type) && block.text !== undefined) {
            summary.offset = offset;
            summary.returnedChars = block.text.length;
            if (hasMore) summary.nextOffset = offset + block.text.length;
          }
          summary.truncated = Boolean(summary.truncated || hasMore);
          return {
            operation: 'read',
            url: this.browser.url,
            title: this.browser.title ?? '',
            revision: this.browser.revision,
            mode,
            source: 'semantic',
            pageType: full.type === 'table' ? 'data_table' : 'generic',
            blocks: [summary],
            diagnostics: { blockCount: 1, tableCount: full.type === 'table' ? 1 : 0, selectedRefs: [{ ref: input.ref }], extractors: [full.source?.extractor ?? 'dom'] },
            readable: Boolean(preview),
            sections: [{ ...(summary.heading ? { heading: summary.heading } : {}), text: preview, ref: input.ref }],
            totalChars: JSON.stringify(full).length,
            returnedChars: preview.length,
            truncated: Boolean(full.truncated || hasMore),
          } as GuestMethodResult[M];
        }

        const blocks = mockContentBlocks(this.browser, this.contentReferences, this.contentSessionId);
        let selected: Array<{ block: BrowserContentBlock; relevance?: number }>;
        if (input.query) {
          const ranked = rankBrowserContentBlocks({ query: input.query, blocks, maxResults: 8 });
          const blocksByRef = new Map(blocks.map(block => [block.ref, block]));
          selected = ranked.results.flatMap(result => {
            const block = blocksByRef.get(result.ref);
            return block ? [{ block, relevance: result.relevance }] : [];
          });
        } else {
          const substantive = blocks.filter(block => !block.boilerplate).sort((left, right) => (
            (right.importance ?? 0) - (left.importance ?? 0)
            || ({ table: 0, search_result: 1, text: 2, list: 3, definition: 4, form: 5, code: 6, heading: 7, other: 8, navigation: 9 }[left.type]
              - { table: 0, search_result: 1, text: 2, list: 3, definition: 4, form: 5, code: 6, heading: 7, other: 8, navigation: 9 }[right.type])
            || left.ref.localeCompare(right.ref)
          )).slice(0, 7);
          const chrome = blocks.find(block => block.boilerplate);
          selected = [...substantive.map(block => ({ block })), ...(chrome ? [{ block: chrome }] : [])];
        }
        const previewChars = Math.max(1, Math.min(520, Math.floor(maxChars / Math.max(1, Math.min(6, selected.length)))));
        const summaries = selected.map(({ block, relevance }) => mockContentSummary(block, previewChars, relevance));
        const pageType = blocks.some(block => block.type === 'search_result') ? 'search_results'
          : blocks.some(block => block.type === 'table') ? 'data_table'
            : blocks.some(block => block.type === 'form') ? 'form' : 'generic';
        const sections = summaries.map(block => ({ ...(block.heading ? { heading: block.heading } : {}), text: block.preview ?? '', ref: block.ref }));
        return {
          operation: 'read',
          url: this.browser.url,
          title: this.browser.title ?? '',
          revision: this.browser.revision,
          mode,
          source: 'semantic',
          pageType,
          ...(input.query ? { query: input.query } : {}),
          blocks: summaries,
          diagnostics: {
            blockCount: blocks.length,
            tableCount: blocks.filter(block => block.type === 'table').length,
            selectedRefs: summaries.map(block => ({ ref: block.ref, ...(block.relevance === undefined ? {} : { relevance: block.relevance }) })),
            extractors: ['dom'],
          },
          readable: blocks.some(block => Boolean(block.text?.trim() || block.rows?.length || block.items?.length || block.title?.trim() || block.snippet?.trim() || block.links?.length || block.fields?.length || block.definitions?.length)),
          sections,
          totalChars: blocks.reduce((sum, block) => sum + JSON.stringify(block).length, 0),
          returnedChars: JSON.stringify(summaries).length,
          truncated: summaries.length < selected.length || blocks.length > summaries.length,
        } as GuestMethodResult[M];
      }
      case 'browser.search': {
        const input = params as GuestMethodParams['browser.search'];
        const blocks = mockContentBlocks(this.browser, this.contentReferences, this.contentSessionId);
        const ranked = rankBrowserContentBlocks({ query: input.query, blocks, maxResults: input.maxResults });
        const blocksByRef = new Map(blocks.map(block => [block.ref, block]));
        const results: BrowserContentSummary[] = ranked.results.flatMap(match => {
          const block = blocksByRef.get(match.ref);
          if (!block) return [];
          return [mockContentSummary(block, 520, match.relevance)];
        });
        const pageReadable = blocks.some(block => Boolean(block.text?.trim() || block.rows?.length || block.items?.length || block.title?.trim() || block.snippet?.trim() || block.links?.length));
        return {
          operation: 'search',
          searchCompleted: true,
          url: this.browser.url ?? 'about:blank',
          title: this.browser.title ?? '',
          revision: this.browser.revision,
          query: input.query,
          semanticBlockCount: ranked.indexedBlockCount,
          matchCount: results.length,
          pageReadable,
          message: results.length > 0
            ? `Search completed successfully. Found ${results.length} matching semantic block${results.length === 1 ? '' : 's'}.`
            : 'Search completed successfully. No semantic content matched the query.',
          results,
        } as GuestMethodResult[M];
      }
      case 'browser.open': {
        const input = params as GuestMethodParams['browser.open'];
        const reference = this.contentReferences.get(input.ref);
        if (!reference || reference.revision !== this.browser.revision || reference.url !== this.browser.url) {
          throw new GuestTransportError('STALE_CONTENT_REF', `Browser content ref ${input.ref} is unknown or stale.`);
        }
        const block = reference.block;
        const link = input.linkIndex === undefined ? undefined : block.links?.[input.linkIndex];
        if (input.linkIndex !== undefined && !link) {
          throw new GuestTransportError('INVALID_LINK_INDEX', `Content ref ${input.ref} has no link at index ${input.linkIndex}.`);
        }
        const observedHref = input.linkIndex === undefined
          ? block.href ?? (block.links?.length === 1 ? block.links[0]?.href : undefined)
          : link?.href;
        if (!observedHref) {
          throw new GuestTransportError(
            block.links && block.links.length > 1 ? 'LINK_INDEX_REQUIRED' : 'CONTENT_REF_HAS_NO_LINK',
            block.links && block.links.length > 1
              ? `Content ref ${input.ref} contains multiple links; specify linkIndex.`
              : `Content ref ${input.ref} does not contain an observed destination URL.`,
          );
        }
        let destination: URL;
        try { destination = new URL(observedHref); } catch {
          throw new GuestTransportError('INVALID_OBSERVED_LINK', 'The observed link is not an absolute URL.');
        }
        if (!['http:', 'https:'].includes(destination.protocol)) {
          throw new GuestTransportError('INVALID_OBSERVED_LINK', 'Observed page links must use HTTP or HTTPS.');
        }
        const navigation = this.navigateMock(observedHref);
        return {
          ...navigation,
          ref: input.ref,
          openedHref: observedHref,
          sourceType: block.type,
        } as GuestMethodResult[M];
      }
      case 'browser.inspectRegion': {
        const input = params as GuestMethodParams['browser.inspectRegion'];
        const match = input.ref.match(/^r(\d+)-([1-9]\d*)$/u);
        const region = match && Number(match[1]) === this.browser.revision
          ? this.browser.regions.find(candidate => candidate.ref === input.ref)
          : undefined;
        if (!region) throw new GuestTransportError('STALE_REGION_REF', `Browser region no longer exists: ${input.ref}`);
        const common = {
          url: this.browser.url ?? 'about:blank',
          title: this.browser.title ?? '',
          revision: this.browser.revision,
          ref: input.ref,
          kind: region.kind,
          ...(region.heading ? { heading: region.heading } : {}),
        };
        const format = input.format === 'auto' || input.format === undefined
          ? region.kind === 'table' ? 'table' : 'text'
          : input.format === 'table' && region.kind !== 'table' ? 'text' : input.format;
        if (format === 'links') {
          const links = (region.links ?? []).slice(0, 80);
          return { ...common, format: 'links', links, linkCount: (region.links ?? []).length, truncated: links.length < (region.links ?? []).length } as GuestMethodResult[M];
        }
        if (format === 'table' && region.kind === 'table') {
          const maxChars = Math.max(1_000, Math.min(12_000, input.maxChars ?? 8_000));
          const offset = Math.max(0, Math.min(1_000_000, input.offset ?? 0));
          const limit = Math.max(1, Math.min(100, input.limit ?? 50));
          const table = boundedTable(region, maxChars, offset, limit);
          return {
            ...common,
            format: 'table',
            columns: table.columns,
            rows: table.rows,
            rowCount: table.rowCount,
            returnedRowCount: table.returnedRowCount,
            offset: table.offset,
            columnCount: region.columnCount ?? region.tableHeaders?.length ?? 0,
            truncated: table.truncated,
          } as GuestMethodResult[M];
        }
        const maxChars = Math.max(1_000, Math.min(12_000, input.maxChars ?? 8_000));
        return { ...common, format: 'text', text: region.searchText.slice(0, maxChars), truncated: region.searchText.length > maxChars } as GuestMethodResult[M];
      }
      case 'browser.download': {
        const input = params as GuestMethodParams['browser.download'];
        const elementRef = input.ref?.match(/^e(\d+)-([1-9]\d*)$/u);
        const element = input.ref === undefined
          ? undefined
          : elementRef && Number(elementRef[1]) === this.browser.revision
            ? this.browser.elements[Number(elementRef[2]) - 1]
            : undefined;
        if (input.ref !== undefined && element === undefined) {
          throw new GuestTransportError('STALE_ELEMENT_REF', `Browser element ref is no longer valid: ${input.ref}`);
        }
        const rawSourceUrl = input.url ?? element?.href ?? this.browser.url ?? 'about:blank';
        let sourceUrl = rawSourceUrl;
        try {
          sourceUrl = new URL(rawSourceUrl, this.browser.url ?? undefined).toString();
        } catch {
          // Keep the raw value in the mock for diagnostics when a fixture uses
          // a non-URL href.
        }
        const configured = this.downloads[sourceUrl];
        const filename = configured?.filename ?? basename(sourceUrl.split('?')[0] ?? 'download');
        const path = normalizeGuestPath(`/home/helm/Downloads/${filename}`);
        const content = configured?.content ?? `Downloaded from ${sourceUrl}\n`;
        this.addDirectoryParents(path);
        this.files.set(path, content);
        return {
          sourceUrl,
          ...(configured?.finalUrl ? { finalUrl: configured.finalUrl } : {}),
          suggestedFilename: filename,
          savedPath: path,
          size: Buffer.byteLength(content, 'utf8'),
          context: configured?.context ?? 'mock-browser',
          startedAt: new Date().toISOString(),
        } as GuestMethodResult[M];
      }
      case 'browser.click': {
        const input = params as GuestMethodParams['browser.click'];
        const elementRef = input.ref?.match(/^e(\d+)-([1-9]\d*)$/u);
        if (input.ref && (!elementRef || Number(elementRef[1]) !== this.browser.revision || !this.browser.elements[Number(elementRef[2]) - 1])) {
          throw new GuestTransportError('STALE_ELEMENT_REF', `Browser element ref is no longer valid: ${input.ref}`);
        }
        this.browser.revision += 1;
        this.contentReferences.clear();
        this.browser.regions = mockRegions(this.browser.html ?? '', this.browser.revision);
        return { ...input, clicked: true } as GuestMethodResult[M];
      }
      case 'browser.type': {
        const input = params as GuestMethodParams['browser.type'];
        const elementRef = input.ref.match(/^e(\d+)-([1-9]\d*)$/u);
        if (!elementRef || Number(elementRef[1]) !== this.browser.revision || !this.browser.elements[Number(elementRef[2]) - 1]) {
          throw new GuestTransportError('STALE_ELEMENT_REF', `Browser element ref is no longer valid: ${input.ref}`);
        }
        const element = this.browser.elements[Number(elementRef[2]) - 1];
        if (element) element.value = input.text;
        this.browser.revision += 1;
        this.contentReferences.clear();
        this.browser.regions = mockRegions(this.browser.html ?? '', this.browser.revision);
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

  private navigateMock(requestedUrl: string): GuestMethodResult['browser.navigate'] {
    const navigationFailure = this.navigationFailures[requestedUrl];
    if (navigationFailure) throw new GuestTransportError('BROWSER_NAVIGATION_FAILED', navigationFailure);
    let url = requestedUrl;
    const visited = new Set<string>();
    while (this.redirects[url] && !visited.has(url)) {
      visited.add(url);
      url = this.redirects[url] as string;
    }
    const path = pathFromFileUrl(url);
    const html = path ? this.files.get(path) : this.pages[url] ?? this.pages[requestedUrl];
    if (path && html === undefined) throw new GuestTransportError('PAGE_NOT_FOUND', `Page does not exist: ${path}`);
    const document = html ?? `<html><body>Mock page for ${url}</body></html>`;
    const title = pageTitle(document, 'Mock page');
    const revision = this.browser.revision + 1;
    this.contentReferences.clear();
    this.browser = {
      url,
      title,
      loaded: true,
      text: readableText(document),
      elements: parseElements(document),
      pageCount: 1,
      revision,
      html: document,
      regions: mockRegions(document, revision),
    };
    this.upsertWindow('browser', 'Chromium', title, true);
    return { url, title, loading: false, pageCount: 1, revision };
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

  private addDirectoryParents(path: string): void {
    let parent = posix.dirname(path);
    while (parent.startsWith(`${MOCK_GUEST_ROOT}/`) || parent === MOCK_GUEST_ROOT) {
      this.directories.add(parent);
      if (parent === MOCK_GUEST_ROOT) break;
      const next = posix.dirname(parent);
      if (next === parent) break;
      parent = next;
    }
  }
}

export { normalizeGuestPath };
