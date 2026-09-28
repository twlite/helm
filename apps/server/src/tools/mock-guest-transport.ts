import { posix } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import type {
  BrowserContentBlock,
  BrowserContentFormat,
  BrowserContentSummary,
  BrowserQueryResult,
  BrowserRegionKind,
  BrowserReadResult,
  BrowserReadMode,
  GuestMethod,
  WindowInfo,
} from '@helm/shared';
import {
  buildDuckDuckGoSearchUrl,
  GUEST_PROTOCOL_VERSION,
  guestMethodSchemas,
  guestProtocolContractJson,
  rankBrowserContentBlocks,
  type IndexedBrowserRegion,
} from '@helm/shared';
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
const MAX_MOCK_BROWSER_QUERY_RESULT_BYTES = 64 * 1024;

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
  /** A deterministic transient failure returned after the page state has committed. */
  navigationFailuresAfterReach?: Record<string, string>;
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
  regions: Array<IndexedBrowserRegion & { tableRows?: string[][]; tableCaption?: string; links?: Array<{ text: string; href: string }>; listItem?: boolean }>;
}

interface MockContentReference {
  block: BrowserContentBlock;
  revision: number;
  url: string;
  title: string;
  pageType: 'article' | 'data_table' | 'search_results' | 'documentation' | 'form' | 'application' | 'generic';
  capturedAt: string;
}

interface MockDocumentReference {
  blocks: BrowserContentBlock[];
  sourceRefs: string[];
  revision: number;
  url: string;
  title: string;
  pageType: 'article' | 'data_table' | 'search_results' | 'documentation' | 'form' | 'application' | 'generic';
  capturedAt: string;
  sourceTruncated: boolean;
}

interface MockQueryCandidate {
  tag: string;
  role: string;
  name: string;
  text: string;
  attributes: Record<string, string>;
  href?: string;
}

interface MockNavigationReference {
  href: string;
  sourceUrl: string;
  sourceType: 'search_result' | 'page_link';
  title?: string;
  snippet?: string;
  observedRevision: number;
  searchId?: number;
  block?: BrowserContentBlock;
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

function queryCandidates(html: string, selector: string): MockQueryCandidate[] {
  const normalizedSelector = selector.trim();
  const target = normalizedSelector.split(/\s+|>/u).filter(Boolean).at(-1) ?? '*';
  const candidates: MockQueryCandidate[] = [];
  const voidElements = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const tagPattern = /<([a-z][a-z0-9:-]*)\b([^>]*)>/giu;
  for (const match of html.matchAll(tagPattern)) {
    const tag = match[1]?.toLowerCase();
    const attributesSource = match[2] ?? '';
    if (!tag) continue;
    const attributes: Record<string, string> = {};
    for (const attribute of attributesSource.matchAll(/([a-z_:][\w:.-]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/giu)) {
      const key = attribute[1]?.toLowerCase();
      if (key) attributes[key] = decodeHtml(attribute[2] ?? attribute[3] ?? attribute[4] ?? '');
    }
    const index = match.index ?? 0;
    const bodyStart = index + match[0].length;
    const close = voidElements.has(tag)
      ? -1
      : html.toLowerCase().indexOf(`</${tag}`, bodyStart);
    const bodyEnd = close < 0 ? bodyStart : close;
    const body = html.slice(bodyStart, bodyEnd);
    if (target !== '*' && target !== tag
      && !(target.startsWith('#') && attributes.id === target.slice(1))
      && !(target.startsWith('.') && (attributes.class ?? '').split(/\s+/u).includes(target.slice(1)))
      && !(/^(?:\[[a-z_:][\w:.-]*(?:=["']?[^\]]+["']?)?\])$/iu.test(target)
        && (() => {
          const attributeMatch = target.match(/^\[([a-z_:][\w:.-]*)(?:=["']?([^\]]+?)["']?)?\]$/iu);
          if (!attributeMatch?.[1]) return false;
          const value = attributes[attributeMatch[1].toLowerCase()];
          return value !== undefined && (attributeMatch[2] === undefined || value === attributeMatch[2]);
        })())) continue;
    const text = readableText(body).slice(0, 500);
    const role = (attributes.role ?? (tag === 'a' && attributes.href ? 'link'
      : tag === 'button' ? 'button'
        : tag === 'table' ? 'table'
          : tag === 'tr' ? 'row'
            : tag === 'td' ? 'cell'
              : tag === 'th' ? 'columnheader'
                : tag === 'textarea' || tag === 'input' ? 'textbox' : 'generic')).toLowerCase();
    const name = (attributes['aria-label'] ?? attributes.title ?? attributes.name ?? text).slice(0, 300);
    const allowedAttributeNames = [
      ...['id', 'class', 'href', 'role', 'aria-label', 'title', 'name', 'type'].filter(key => attributes[key] !== undefined),
      ...Object.keys(attributes).filter(key => key.startsWith('data-')).slice(0, 8),
    ];
    const allowedAttributes = Object.fromEntries(allowedAttributeNames.map(key => [key, (attributes[key] ?? '').slice(0, 300)]));
    const href = attributes.href && ['a', 'area'].includes(tag) ? attributes.href : undefined;
    candidates.push({ tag, role, name, text, attributes: allowedAttributes, ...(href ? { href } : {}) });
    if (candidates.length >= 2_000) break;
  }
  return candidates;
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
  const regions: Array<IndexedBrowserRegion & { tableRows?: string[][]; tableCaption?: string; links?: Array<{ text: string; href: string }>; listItem?: boolean }> = [];
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
    // Avoid indexing container text twice when a nested semantic landmark owns
    // structured data or site chrome. Child table/navigation blocks carry the
    // useful content without duplicating the whole page as prose.
    if (['main', 'article', 'section'].includes(tag)
      && /<(?:table|nav|footer|aside|article|section)\b/iu.test(body)) continue;
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
    const tableCaption = tag === 'table'
      ? readableText(body.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/iu)?.[1] ?? '')
      : undefined;
    const candidateIndex = regions.length;
    const previewSource = kind === 'table'
      ? `${tableHeaders?.join(' ') ?? ''} ${tableRows[0]?.join(' ') ?? ''}`
      : text;
    const region: IndexedBrowserRegion & { tableRows?: string[][]; tableCaption?: string; links?: Array<{ text: string; href: string }>; listItem?: boolean } = {
      ref: `r${revision}-${candidateIndex + 1}`,
      kind,
      ...(kind === 'heading' ? { heading: text.slice(0, 160) } : heading ? { heading } : {}),
      preview: previewSource.replace(/\s+/gu, ' ').trim().slice(0, 180),
      searchText: text,
      ...(tableHeaders ? { tableHeaders } : {}),
      ...(tableCaption ? { tableCaption } : {}),
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

function mockStructured(block: BrowserContentBlock): boolean {
  return ['table', 'list', 'definition', 'form'].includes(block.type);
}

function mockRelatedTableSelection(
  blocks: readonly BrowserContentBlock[],
  seeds: readonly BrowserContentBlock[],
  pageType: MockDocumentReference['pageType'],
): BrowserContentBlock[] {
  const selected = new Set(seeds.map(block => block.ref));
  if (pageType === 'data_table') {
    for (const seed of seeds.filter(block => block.type === 'table')) {
      const seedIndex = blocks.findIndex(block => block.ref === seed.ref);
      const schema = (block: BrowserContentBlock): string => (block.columns ?? []).map(column =>
        column.toLocaleLowerCase().replace(/[^a-z0-9]+/giu, ''),
      ).join('|');
      const seedSchema = schema(seed);
      if (!seedSchema) continue;
      for (const [candidateIndex, candidate] of blocks.entries()) {
        if (candidate.type !== 'table' || selected.has(candidate.ref) || Math.abs(candidateIndex - seedIndex) > 4) continue;
        if (schema(candidate) !== seedSchema || JSON.stringify(candidate.headingPath ?? []) !== JSON.stringify(seed.headingPath ?? [])) continue;
        const words = (value: string): Set<string> => new Set(value.toLocaleLowerCase().match(/[a-z0-9]+/giu) ?? []);
        const candidateCaption = candidate.caption ?? '';
        const seedCaption = seed.caption ?? '';
        const compatibleCaptions = !candidateCaption || !seedCaption
          || [...words(candidateCaption)].some(word => words(seedCaption).has(word));
        if (compatibleCaptions) selected.add(candidate.ref);
      }
    }
  }
  return blocks.filter(block => selected.has(block.ref));
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
  navigationReferences?: Map<string, MockNavigationReference>,
  navigationCounter?: { index: number; searchId: number },
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
    const contentRef = `c${browser.revision}-${contentSessionId}-${index + 1}`;
    const observedLinks = (region.links ?? []).flatMap(link => {
      try {
        const target = new URL(link.href, browser.url);
        if (!['http:', 'https:'].includes(target.protocol)) return [];
        if (!['http:', 'https:'].includes(target.protocol)) return [];
        return [{ text: link.text, href: target.href }];
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
      if (navigationReferences && navigationCounter) {
        navigationCounter.index += 1;
        const navRef = `n-${contentSessionId}-${navigationCounter.index}`;
        return {
          ref: navRef,
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
      return {
        ref: contentRef,
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
        ref: contentRef,
        type: 'table',
        ...(region.heading ? { heading: region.heading, headingPath: [region.heading] } : {}),
        ...(region.tableCaption ? { caption: region.tableCaption } : {}),
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
        ref: contentRef,
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
        ref: contentRef,
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
      ref: contentRef,
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
    if (block.type === 'search_result' && navigationReferences && block.ref.startsWith('n-')) {
      navigationReferences.set(block.ref, {
        href: block.href ?? '',
        sourceUrl: browser.url ?? '',
        sourceType: 'search_result',
        ...(block.title === undefined ? {} : { title: block.title }),
        ...(block.snippet === undefined ? {} : { snippet: block.snippet }),
        observedRevision: browser.revision,
        ...(navigationCounter ? { searchId: navigationCounter.searchId } : {}),
        block,
      });
    } else {
      const snapshot = JSON.parse(JSON.stringify(block)) as BrowserContentBlock;
      const pageType = blocks.some(candidate => candidate.type === 'search_result') ? 'search_results'
        : blocks.some(candidate => candidate.type === 'table') ? 'data_table'
          : blocks.some(candidate => candidate.type === 'form') ? 'form' : 'generic';
      contentReferences.set(block.ref, {
        block: snapshot,
        revision: browser.revision,
        url: browser.url ?? '',
        title: browser.title ?? '',
        pageType,
        capturedAt: new Date().toISOString(),
      });
    }
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
    ref: block.ref,
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

function mockSerializeDocument(document: MockDocumentReference, format: BrowserContentFormat): string {
  if (format === 'json') return `${JSON.stringify({
    type: 'document',
    sourceUrl: document.url,
    sourceTitle: document.title,
    capturedAt: document.capturedAt,
    sourceRevision: document.revision,
    sourceRefs: document.sourceRefs,
    sourceTruncated: document.sourceTruncated,
    blocks: document.blocks.map(block => JSON.parse(mockSerializeContent(block, 'json')) as unknown),
  }, null, 2)}\n`;
  if (format === 'csv') {
    const tables = document.blocks.filter(block => block.type === 'table');
    if (document.blocks.length !== 1 || tables.length !== 1) {
      throw new GuestTransportError('UNSUPPORTED_CONTENT_FORMAT', `CSV export requires a single table block with no other blocks; this snapshot contains ${document.blocks.length} blocks and ${tables.length} tables. Use text, markdown, or json for a composite document.`);
    }
    return mockSerializeContent(tables[0]!, 'csv');
  }
  return document.blocks.map(block => mockSerializeContent(block, format).trimEnd()).filter(Boolean).join('\n\n') + '\n';
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
  private readonly navigationFailuresAfterReach: Record<string, string>;
  private readonly delayMs: number;
  private readonly downloads: Record<string, { finalUrl?: string; filename: string; content?: string; context?: string }>;
  private readonly windows = new Map<string, WindowInfo>();
  private readonly contentReferences = new Map<string, MockContentReference>();
  private readonly documentReferences = new Map<string, MockDocumentReference>();
  private readonly navigationReferences = new Map<string, MockNavigationReference>();
  private readonly queryElementReferences = new Map<string, MockBrowserElement>();
  private navigationIndex = 0;
  private documentReferenceIndex = 0;
  private queryReferenceIndex = 0;
  private searchGeneration = 0;
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
    this.navigationFailuresAfterReach = { ...(options.navigationFailuresAfterReach ?? {}) };
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

  /** Simulate an irrelevant DOM mutation that invalidates live DOM refs only. */
  simulateDomMutation(): void {
    if (!this.browser.loaded) return;
    this.browser.revision += 1;
    this.queryElementReferences.clear();
    this.browser.regions = mockRegions(this.browser.html ?? '', this.browser.revision);
  }

  reset(): void {
    this.files.clear();
    this.directories.clear();
    this.directories.add(MOCK_GUEST_ROOT);
    this.files.set(DEMO_PAGE_PATH, DEMO_PAGE_HTML);
    this.addDirectoryParents(DEMO_PAGE_PATH);
    this.windows.clear();
    this.contentReferences.clear();
    this.documentReferences.clear();
    this.navigationReferences.clear();
    this.queryElementReferences.clear();
    this.navigationIndex = 0;
    this.queryReferenceIndex = 0;
    this.searchGeneration = 0;
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
          runtime: 'helm-guest',
          protocolVersion: GUEST_PROTOCOL_VERSION,
          buildId: createHash('sha256').update('helm-mock-guest').digest('hex'),
          protocolContractSha256: createHash('sha256').update(guestProtocolContractJson()).digest('hex'),
          bundleSha256: createHash('sha256').update('helm-mock-guest-bundle').digest('hex'),
          serverId: (params as GuestMethodParams['guest.handshake']).serverId,
          methods: Object.keys(guestMethodSchemas),
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
        let content = input.content;
        let sourceReference: MockContentReference | undefined;
        let documentReference: MockDocumentReference | undefined;
        if (input.sourceRef) {
          sourceReference = this.contentReferences.get(input.sourceRef);
          documentReference = this.documentReferences.get(input.sourceRef);
          if (!sourceReference && !documentReference) {
            throw new GuestTransportError('UNKNOWN_CONTENT_REF', `Browser content ref ${input.sourceRef} is unknown or expired.`);
          }
          content = sourceReference
            ? mockSerializeContent(sourceReference.block, input.format ?? 'text')
            : mockSerializeDocument(documentReference!, input.format ?? 'text');
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
          ...(input.sourceRef && (sourceReference || documentReference) ? {
            sourceRef: input.sourceRef,
            sourceType: sourceReference?.block.type ?? 'document',
            sourceRevision: sourceReference?.revision ?? documentReference?.revision,
            sourceUrl: sourceReference?.url ?? documentReference?.url,
            sourceCapturedAt: sourceReference?.capturedAt ?? documentReference?.capturedAt,
            sourceRefs: sourceReference ? [input.sourceRef] : documentReference?.sourceRefs,
            sourceStructuredBlockCount: sourceReference ? Number(mockStructured(sourceReference.block)) : documentReference?.blocks.filter(mockStructured).length,
            sourceTableCount: sourceReference ? Number(sourceReference.block.type === 'table') : documentReference?.blocks.filter(block => block.type === 'table').length,
            sourceTruncated: sourceReference ? Boolean(sourceReference.block.truncated) : documentReference?.sourceTruncated,
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
            ...((params as GuestMethodParams['fs.stat']).includeSha256
              ? { sha256: createHash('sha256').update(content, 'utf8').digest('hex') }
              : {}),
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
      case 'browser.query': {
        if (!this.browser.loaded || !this.browser.url || !this.browser.html) {
          throw new GuestTransportError('BROWSER_NOT_READY', 'Navigate the browser before querying the page');
        }
        const input = params as GuestMethodParams['browser.query'];
        const selector = input.selector?.trim() || 'body *';
        const candidates = queryCandidates(this.browser.html, selector)
          .filter(candidate => !input.text || candidate.text.toLocaleLowerCase().includes(input.text.toLocaleLowerCase()))
          .filter(candidate => !input.role || candidate.role === input.role.toLocaleLowerCase())
          .filter(candidate => !input.name || candidate.name.toLocaleLowerCase().includes(input.name.toLocaleLowerCase()));
        const limit = Math.max(1, Math.min(100, input.limit ?? 20));
        const selected = candidates.slice(0, limit);
        const results: BrowserQueryResult['results'] = selected.map(candidate => {
          const ref = `e${this.browser.revision}-q${++this.queryReferenceIndex}`;
          this.queryElementReferences.set(ref, {
            ref,
            role: candidate.role,
            name: candidate.name,
            text: candidate.text,
            enabled: true,
            ...(candidate.href ? { href: candidate.href } : {}),
          });
          let navigationRef: string | undefined;
          if (candidate.href) {
            try {
              const href = new URL(candidate.href, this.browser.url).toString();
              if (['http:', 'https:'].includes(new URL(href).protocol)) {
                navigationRef = `n-${this.contentSessionId}-${++this.navigationIndex}`;
                this.navigationReferences.set(navigationRef, {
                  href,
                  sourceUrl: this.browser.url ?? '',
                  sourceType: 'page_link',
                  title: candidate.name || candidate.text,
                  observedRevision: this.browser.revision,
                });
              }
            } catch {
              // A malformed href is returned as an attribute but is not a navigable ref.
            }
          }
          return {
            ref,
            tag: candidate.tag,
            role: candidate.role,
            ...(candidate.name ? { name: candidate.name } : {}),
            ...(candidate.text ? { text: candidate.text } : {}),
            attributes: candidate.attributes,
            ...(navigationRef ? { navigationRef } : {}),
          };
        });
        let truncated = candidates.length > selected.length;
        while (results.length > 0 && Buffer.byteLength(JSON.stringify({
          url: this.browser.url,
          title: this.browser.title ?? '',
          revision: this.browser.revision,
          results,
          truncated,
        }), 'utf8') > MAX_MOCK_BROWSER_QUERY_RESULT_BYTES) {
          const removed = results.pop()!;
          this.queryElementReferences.delete(removed.ref);
          if (removed.navigationRef) this.navigationReferences.delete(removed.navigationRef);
          truncated = true;
        }
        return {
          url: this.browser.url,
          title: this.browser.title ?? '',
          revision: this.browser.revision,
          results,
          truncated,
        } as GuestMethodResult[M];
      }
      case 'browser.evaluate':
        throw new GuestTransportError('BROWSER_EVALUATE_UNAVAILABLE', 'The deterministic mock guest does not execute JavaScript outside a browser page context. Use browser.query or a real browser guest.');
      case 'browser.read': {
        if (!this.browser.loaded || !this.browser.url) {
          throw new GuestTransportError('BROWSER_NOT_READY', 'Navigate the browser before reading page content');
        }
        return this.readMockContent(params as GuestMethodParams['browser.read']) as GuestMethodResult[M];
      }
      case 'browser.findPage': {
        const input = params as GuestMethodParams['browser.findPage'];
        if (!this.browser.loaded || !this.browser.url || this.browser.url === 'about:blank') {
          throw new GuestTransportError(
            'BROWSER_NOT_READY',
            'browser.findPage searches the current page only. Use browser.webSearch for DuckDuckGo web discovery.',
          );
        }
        const findCounter = { index: this.navigationIndex, searchId: this.searchGeneration };
        const blocks = mockContentBlocks(this.browser, this.contentReferences, this.contentSessionId, this.navigationReferences, findCounter);
        this.navigationIndex = findCounter.index;
        const ranked = rankBrowserContentBlocks({ query: input.query, blocks, maxResults: input.maxResults });
        const blocksByRef = new Map(blocks.map(block => [block.ref, block]));
        const results: BrowserContentSummary[] = ranked.results.flatMap(match => {
          const block = blocksByRef.get(match.ref);
          if (!block) return [];
          return [mockContentSummary(block, 520, match.relevance)];
        });
        const pageReadable = blocks.some(block => Boolean(block.text?.trim() || block.rows?.length || block.items?.length || block.title?.trim() || block.snippet?.trim() || block.links?.length));
        return {
          operation: 'find_page',
          pageSearchCompleted: true,
          url: this.browser.url ?? 'about:blank',
          title: this.browser.title ?? '',
          revision: this.browser.revision,
          query: input.query,
          semanticBlockCount: ranked.indexedBlockCount,
          matchCount: results.length,
          pageReadable,
          message: results.length > 0
            ? `Current-page search found ${results.length} matching semantic block${results.length === 1 ? '' : 's'}.`
            : 'Current-page search found no matching semantic content.',
          results,
        } as GuestMethodResult[M];
      }
      case 'browser.webSearch': {
        const input = params as GuestMethodParams['browser.webSearch'];
        const requestedUrl = buildDuckDuckGoSearchUrl(input.query);
        const navigation = this.navigateMock(requestedUrl);
        this.searchGeneration += 1;
        for (const [key, value] of [...this.navigationReferences]) {
          if (value.sourceType === 'search_result') this.navigationReferences.delete(key);
        }
        const webCounter = { index: this.navigationIndex, searchId: this.searchGeneration };
        const blocks = mockContentBlocks(this.browser, this.contentReferences, this.contentSessionId, this.navigationReferences, webCounter);
        this.navigationIndex = webCounter.index;
        const searchResults = blocks.filter(block => block.type === 'search_result');
        const ranked = rankBrowserContentBlocks({
          query: input.query,
          blocks: searchResults,
          maxResults: input.maxResults ?? 10,
        });
        const blocksByRef = new Map(searchResults.map(block => [block.ref, block]));
        const results = ranked.results.flatMap(match => {
          const block = blocksByRef.get(match.ref);
          return block?.type === 'search_result' && block.title && block.href
            ? [{ ...mockContentSummary(block, 520, match.relevance), type: 'search_result' as const, title: block.title, href: block.href }]
            : [];
        });
        if (results.length === 0) {
          throw new GuestTransportError(
            'WEB_SEARCH_RESULTS_UNAVAILABLE',
            'DuckDuckGo did not expose any result links on the loaded page. Inspect the browser page or try another query.',
          );
        }
        const pageReadable = searchResults.length > 0;
        return {
          operation: 'web_search',
          searchEngine: 'duckduckgo',
          searchCompleted: true,
          requestedUrl,
          url: navigation.url,
          title: navigation.title,
          revision: navigation.revision,
          query: input.query,
          semanticBlockCount: blocks.length,
          matchCount: results.length,
          pageReadable,
          message: `DuckDuckGo returned ${results.length} observed result${results.length === 1 ? '' : 's'}.`,
          results,
        } as GuestMethodResult[M];
      }
      case 'browser.open': {
        const input = params as GuestMethodParams['browser.open'];
        const navigationRef = this.navigationReferences.get(input.ref);
        if (navigationRef) {
          if (input.linkIndex !== undefined) {
            throw new GuestTransportError('INVALID_LINK_INDEX', `Navigation ref ${input.ref} does not use linkIndex.`);
          }
          let navDestination: URL;
          try { navDestination = new URL(navigationRef.href); } catch {
            throw new GuestTransportError('INVALID_OBSERVED_LINK', 'The observed link is not an absolute URL.');
          }
          if (!['http:', 'https:'].includes(navDestination.protocol)) {
            throw new GuestTransportError('INVALID_OBSERVED_LINK', 'Observed page links must use HTTP or HTTPS.');
          }
          const navResult = this.navigateMock(navigationRef.href);
          return {
            ...navResult,
            ref: input.ref,
            openedHref: navigationRef.href,
            sourceType: navigationRef.sourceType,
          } as GuestMethodResult[M];
        }
        const reference = this.contentReferences.get(input.ref);
        if (!reference) {
          throw new GuestTransportError('UNKNOWN_CONTENT_REF', `Browser content ref ${input.ref} is unknown or expired.`);
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
        const element = input.ref === undefined ? undefined : this.resolveElementReference(input.ref);
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
        if (input.ref && !this.resolveElementReference(input.ref)) {
          throw new GuestTransportError('STALE_ELEMENT_REF', `Browser element ref is no longer valid: ${input.ref}`);
        }
        this.browser.revision += 1;
        this.queryElementReferences.clear();
        this.browser.regions = mockRegions(this.browser.html ?? '', this.browser.revision);
        return { ...input, clicked: true } as GuestMethodResult[M];
      }
      case 'browser.type': {
        const input = params as GuestMethodParams['browser.type'];
        const element = this.resolveElementReference(input.ref);
        if (!element) {
          throw new GuestTransportError('STALE_ELEMENT_REF', `Browser element ref is no longer valid: ${input.ref}`);
        }
        if (element) element.value = input.text;
        this.browser.revision += 1;
        this.queryElementReferences.clear();
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

  private readMockContent(input: GuestMethodParams['browser.read']): BrowserReadResult {
    const maxChars = Math.max(1, Math.min(12_000, input.maxChars ?? 4_000));
    if ('ref' in input) {
      if (this.navigationReferences.has(input.ref)) {
        throw new GuestTransportError('NAVIGATION_REF_REQUIRES_OPEN', `Browser ref ${input.ref} is an observed navigation destination. Use browser.open({ ref: "${input.ref}" }) to navigate to it.`);
      }
      const document = this.documentReferences.get(input.ref);
      if (document) {
        const offset = Math.max(0, input.offset ?? 0);
        const limit = Math.max(1, Math.min(100, input.limit ?? 20));
        const candidates = document.blocks.slice(offset, offset + limit);
        const summaries = candidates.map(block => mockContentSummary(block, Math.max(120, Math.floor(maxChars / Math.max(1, candidates.length)))));
        const returnedChars = summaries.reduce((sum, summary) => sum + JSON.stringify(summary).length, 0);
        const structured = document.blocks.filter(block => ['table', 'list', 'definition', 'form'].includes(block.type));
        const structuredBlocks = structured.slice(0, 20).map(block => this.mockStructuredSummary(block, true));
        return {
          operation: 'read',
          url: document.url,
          title: document.title,
          revision: document.revision,
          mode: 'document',
          source: 'semantic',
          pageType: document.pageType,
          documentRef: input.ref,
          sourceRefs: [...document.sourceRefs],
          sourceCapturedAt: document.capturedAt,
          sourceStructuredBlockCount: structured.length,
          sourceTableCount: document.blocks.filter(block => block.type === 'table').length,
          sourceTruncated: document.sourceTruncated,
          blocks: summaries,
          diagnostics: {
            blockCount: document.blocks.length,
            tableCount: document.blocks.filter(block => block.type === 'table').length,
            selectedBlockCount: document.blocks.length,
            documentBlockCount: document.blocks.length,
            documentTableCount: document.blocks.filter(block => block.type === 'table').length,
            documentStructuredBlockCount: structured.length,
            documentSourceRefs: document.blocks.map(block => ({ ref: block.ref, type: block.type })),
            structuredBlockCount: structured.length,
            structuredBlocksTruncated: structured.length > structuredBlocks.length,
            structuredBlocks,
            sourceTruncated: document.sourceTruncated,
            summariesArePreviews: true,
            documentRef: input.ref,
            selectedRefs: summaries.map(block => ({ ref: block.ref })),
            extractors: [...new Set(document.blocks.map(block => block.source?.extractor ?? 'dom'))],
          },
          readable: summaries.length > 0,
          sections: summaries.map(block => ({ ...(block.heading ? { heading: block.heading } : {}), text: block.preview ?? '', ref: block.ref })),
          totalChars: document.blocks.reduce((sum, block) => sum + JSON.stringify(block).length, 0),
          returnedChars,
          truncated: document.sourceTruncated || offset > 0 || summaries.length < candidates.length || offset + summaries.length < document.blocks.length,
        };
      }
      const reference = this.contentReferences.get(input.ref);
      if (!reference) throw new GuestTransportError('UNKNOWN_CONTENT_REF', `Browser content ref ${input.ref} is unknown or expired.`);
      const full = reference.block;
      const offset = Math.max(0, input.offset ?? 0);
      const limit = Math.max(1, Math.min(100, input.limit ?? 20));
      let block: BrowserContentBlock = { ...full };
      let hasMore = false;
      let paged = false;
      if (full.type === 'table') {
        block = { ...full, rows: (full.rows ?? []).slice(offset, offset + limit) };
        hasMore = offset + (block.rows?.length ?? 0) < (full.rows?.length ?? 0);
        paged = true;
      } else if (full.type === 'list') {
        block = { ...full, items: (full.items ?? []).slice(offset, offset + limit) };
        hasMore = offset + (block.items?.length ?? 0) < (full.items?.length ?? 0);
        paged = true;
      } else if (full.type === 'definition') {
        block = { ...full, definitions: (full.definitions ?? []).slice(offset, offset + limit) };
        hasMore = offset + (block.definitions?.length ?? 0) < (full.definitions?.length ?? 0);
        paged = true;
      } else if (full.type === 'form') {
        block = { ...full, fields: (full.fields ?? []).slice(offset, offset + limit) };
        hasMore = offset + (block.fields?.length ?? 0) < (full.fields?.length ?? 0);
        paged = true;
      } else if (full.type === 'navigation') {
        block = { ...full, links: (full.links ?? []).slice(offset, offset + limit) };
        hasMore = offset + (block.links?.length ?? 0) < (full.links?.length ?? 0);
        paged = true;
      } else if (['text', 'code', 'other', 'heading'].includes(full.type) && full.text !== undefined) {
        const charLimit = Math.min(maxChars, input.limit ?? maxChars);
        block = { ...full, text: full.text.slice(offset, offset + charLimit) };
        hasMore = offset + (block.text?.length ?? 0) < full.text.length;
        paged = true;
      } else if (input.offset !== undefined || input.limit !== undefined) {
        throw new GuestTransportError('UNSUPPORTED_CONTENT_PAGINATION', `Content ref ${input.ref} is a ${full.type} block and does not support offset/limit pagination.`);
      }
      const summary = mockContentSummary(block, maxChars);
      if (block.type === 'table') {
        summary.rows = block.rows ?? [];
        summary.offset = offset;
        summary.returnedRowCount = summary.rows.length;
        if (hasMore) summary.nextOffset = offset + summary.rows.length;
      } else if (block.type === 'list') {
        summary.items = block.items ?? [];
        summary.offset = offset;
        summary.returnedRowCount = summary.items.length;
        if (hasMore) summary.nextOffset = offset + summary.items.length;
      } else if (block.type === 'definition') {
        summary.definitions = block.definitions ?? [];
        summary.offset = offset;
        summary.returnedRowCount = summary.definitions.length;
        if (hasMore) summary.nextOffset = offset + summary.definitions.length;
      } else if (block.type === 'form') {
        summary.fields = block.fields ?? [];
        summary.offset = offset;
        summary.returnedRowCount = summary.fields.length;
        if (hasMore) summary.nextOffset = offset + summary.fields.length;
      } else if (block.type === 'navigation') {
        summary.links = block.links ?? [];
        summary.offset = offset;
        summary.returnedRowCount = summary.links.length;
        if (hasMore) summary.nextOffset = offset + summary.links.length;
      } else if (['text', 'code', 'other', 'heading'].includes(block.type) && block.text !== undefined) {
        summary.offset = offset;
        summary.returnedChars = block.text.length;
        if (hasMore) summary.nextOffset = offset + block.text.length;
      }
      summary.truncated = Boolean(summary.truncated || (paged && hasMore));
      return {
        operation: 'read',
        url: reference.url,
        title: reference.title,
        revision: reference.revision,
        mode: 'readable',
        source: 'semantic',
        pageType: reference.pageType,
        sourceRefs: [reference.block.ref],
        sourceCapturedAt: reference.capturedAt,
        sourceStructuredBlockCount: Number(mockStructured(reference.block)),
        sourceTableCount: Number(reference.block.type === 'table'),
        sourceTruncated: Boolean(reference.block.truncated),
        blocks: [summary],
        diagnostics: {
          blockCount: 1,
          tableCount: full.type === 'table' ? 1 : 0,
          selectedBlockCount: 1,
          structuredBlockCount: ['table', 'list', 'definition', 'form'].includes(full.type) ? 1 : 0,
          structuredBlocks: ['table', 'list', 'definition', 'form'].includes(full.type) ? [this.mockStructuredSummary(full, true)] : [],
          structuredBlocksTruncated: false,
          sourceTruncated: false,
          summariesArePreviews: true,
          selectedRefs: [{ ref: input.ref }],
          extractors: [full.source?.extractor ?? 'dom'],
        },
        readable: Boolean(summary.preview),
        sections: [{ ...(summary.heading ? { heading: summary.heading } : {}), text: summary.preview ?? '', ref: input.ref }],
        totalChars: JSON.stringify(full).length,
        returnedChars: summary.preview?.length ?? 0,
        truncated: Boolean(hasMore),
      };
    }

    const mode: BrowserReadMode = input.mode ?? 'readable';
    const maxBlocks = Math.max(1, Math.min(20, input.maxBlocks ?? (mode === 'document' ? 20 : 7)));
    const navCounter = { index: this.navigationIndex, searchId: this.searchGeneration };
    const extracted = mockContentBlocks(this.browser, this.contentReferences, this.contentSessionId, this.navigationReferences, navCounter);
    this.navigationIndex = navCounter.index;
    const blocks = input.blockTypes ? extracted.filter(block => input.blockTypes!.includes(block.type)) : extracted;
    const explicitlyRequestedNavigation = input.blockTypes?.includes('navigation') === true;
    const includeBoilerplate = mode === 'document' && explicitlyRequestedNavigation;
    const readableCandidates = explicitlyRequestedNavigation
      ? blocks
      : blocks.filter(block => !block.boilerplate && block.type !== 'navigation');
    const documentCandidates = mode === 'document'
      ? blocks.filter(block => includeBoilerplate || (!block.boilerplate && block.type !== 'navigation'))
      : blocks;
    const pageType = blocks.some(block => block.type === 'search_result') ? 'search_results'
      : blocks.some(block => block.type === 'table') ? 'data_table'
        : blocks.some(block => block.type === 'form') ? 'form' : 'generic';
    let documentBlocks: BrowserContentBlock[];
    let previewCandidates: BrowserContentBlock[];
    const previewRelevance = new Map<string, number>();
    if (mode === 'document') {
      if (input.query) {
        const ranked = rankBrowserContentBlocks({ query: input.query, blocks: documentCandidates, maxResults: documentCandidates.length });
        const rankedRefs = new Set(ranked.results.map(result => result.ref));
        const seeds = documentCandidates.filter(block => rankedRefs.has(block.ref));
        documentBlocks = mockRelatedTableSelection(documentCandidates, seeds, pageType);
      } else {
        documentBlocks = documentCandidates;
      }
      documentBlocks = extracted.filter(block => documentBlocks.some(candidate => candidate.ref === block.ref));
      previewCandidates = input.query
        ? (() => {
          const ranked = rankBrowserContentBlocks({ query: input.query!, blocks: documentBlocks, maxResults: maxBlocks });
          const blocksByRef = new Map(documentBlocks.map(block => [block.ref, block]));
          for (const result of ranked.results) previewRelevance.set(result.ref, result.relevance);
          return ranked.results.flatMap(result => {
            const block = blocksByRef.get(result.ref);
            return block ? [block] : [];
          });
        })()
        : documentBlocks.slice(0, maxBlocks);
    } else {
      documentBlocks = [];
      if (input.query) {
        const ranked = rankBrowserContentBlocks({ query: input.query, blocks: readableCandidates, maxResults: maxBlocks });
        const blocksByRef = new Map(readableCandidates.map(block => [block.ref, block]));
        for (const result of ranked.results) previewRelevance.set(result.ref, result.relevance);
        previewCandidates = ranked.results.flatMap(result => {
          const block = blocksByRef.get(result.ref);
          return block ? [block] : [];
        });
      } else {
        const substantive = blocks.filter(block => !block.boilerplate);
        previewCandidates = [...substantive].sort((left, right) => (
          (right.importance ?? 0) - (left.importance ?? 0)
          || ({ table: 0, search_result: 1, text: 2, list: 3, definition: 4, form: 5, code: 6, heading: 7, other: 8, navigation: 9 }[left.type]
            - { table: 0, search_result: 1, text: 2, list: 3, definition: 4, form: 5, code: 6, heading: 7, other: 8, navigation: 9 }[right.type])
          || left.ref.localeCompare(right.ref)
        )).slice(0, maxBlocks);
        const chrome = blocks.find(block => block.boilerplate);
        if (chrome && previewCandidates.length < maxBlocks) previewCandidates.push(chrome);
      }
    }
    const previewSelection = previewCandidates.slice(0, maxBlocks);
    const previewChars = Math.max(0, Math.min(520, Math.floor(maxChars / Math.max(1, Math.min(8, previewSelection.length)))));
    const summaries: BrowserContentSummary[] = [];
    let returnedChars = 0;
    for (const block of previewSelection) {
      const remaining = maxChars - returnedChars;
      let summary = mockContentSummary(block, previewChars, previewRelevance.get(block.ref));
      if (JSON.stringify(summary).length > remaining) {
        const minimal: BrowserContentSummary = {
          ref: block.ref,
          type: block.type,
          ...(block.caption ? { caption: block.caption.slice(0, 120) } : {}),
          ...(block.rowCount === undefined ? {} : { rowCount: block.rowCount }),
          ...(block.columnCount === undefined ? {} : { columnCount: block.columnCount }),
        };
        let preview = summary.preview ?? '';
        while (preview.length > 0) {
          minimal.preview = preview;
          if (JSON.stringify(minimal).length <= remaining) break;
          preview = preview.slice(0, Math.floor(preview.length / 2));
        }
        if (JSON.stringify(minimal).length > remaining) break;
        summary = minimal;
      }
      const cost = JSON.stringify(summary).length;
      if (returnedChars + cost > maxChars) break;
      summaries.push(summary);
      returnedChars += cost;
    }
    const selectedRefs = new Set(summaries.map(summary => summary.ref));
    const sourceBlocks = mode === 'document' ? documentBlocks : previewSelection.filter(block => selectedRefs.has(block.ref));
    const structured = extracted.filter(block => ['table', 'list', 'definition', 'form'].includes(block.type));
    const documentRef = mode === 'document' && documentBlocks.length > 0
      ? this.registerMockDocumentReference(documentBlocks, pageType)
      : undefined;
    const documentRefs = new Set(documentBlocks.map(block => block.ref));
    const structuredBlocks = structured.slice(0, 20).map(block => this.mockStructuredSummary(block, selectedRefs.has(block.ref), documentRefs.has(block.ref)));
    const documentStructured = documentBlocks.filter(mockStructured);
    const documentSourceRefs = documentBlocks.map(block => ({ ref: block.ref, type: block.type }));
    return {
      operation: 'read',
      url: this.browser.url ?? 'about:blank',
      title: this.browser.title ?? '',
      revision: this.browser.revision,
      mode,
      source: 'semantic',
      pageType,
      ...(input.query ? { query: input.query } : {}),
      ...(documentRef ? { documentRef } : {}),
      sourceRefs: sourceBlocks.map(block => block.ref),
      ...(documentRef ? { sourceCapturedAt: this.documentReferences.get(documentRef)?.capturedAt } : { sourceCapturedAt: new Date().toISOString() }),
      sourceStructuredBlockCount: sourceBlocks.filter(mockStructured).length,
      sourceTableCount: sourceBlocks.filter(block => block.type === 'table').length,
      sourceTruncated: false,
      blocks: summaries,
      diagnostics: {
        blockCount: extracted.length,
        tableCount: extracted.filter(block => block.type === 'table').length,
        selectedBlockCount: summaries.length,
        documentBlockCount: documentBlocks.length,
        documentTableCount: documentBlocks.filter(block => block.type === 'table').length,
        documentStructuredBlockCount: documentStructured.length,
        documentSourceRefs,
        structuredBlockCount: structured.length,
        structuredBlocksTruncated: structured.length > structuredBlocks.length,
        structuredBlocks,
        sourceTruncated: false,
        summariesArePreviews: true,
        ...(documentRef ? { documentRef } : {}),
        selectedRefs: summaries.map(block => ({ ref: block.ref, ...(block.relevance === undefined ? {} : { relevance: block.relevance }) })),
        extractors: ['dom'],
      },
      readable: extracted.some(block => Boolean(block.text?.trim() || block.rows?.length || block.items?.length || block.title?.trim() || block.snippet?.trim() || block.links?.length || block.fields?.length || block.definitions?.length)),
      sections: summaries.map(block => ({ ...(block.heading ? { heading: block.heading } : {}), text: block.preview ?? '', ref: block.ref })),
      totalChars: extracted.reduce((sum, block) => sum + JSON.stringify(block).length, 0),
      returnedChars,
      truncated: summaries.length < previewSelection.length || documentBlocks.length > summaries.length || extracted.length > summaries.length,
    };
  }

  private mockStructuredSummary(block: BrowserContentBlock, selected: boolean, includedInDocument = false) {
    return {
      ref: block.ref,
      type: block.type as 'table' | 'list' | 'definition' | 'form',
      ...(block.heading ? { heading: block.heading.slice(0, 160) } : {}),
      ...(block.headingPath ? { headingPath: block.headingPath.slice(0, 8).map(value => value.slice(0, 160)) } : {}),
      ...(block.caption ? { caption: block.caption.slice(0, 240) } : {}),
      ...(block.rowCount === undefined ? {} : { rowCount: block.rowCount }),
      ...(block.columnCount === undefined ? {} : { columnCount: block.columnCount }),
      selected,
      includedInDocument,
      previewOnly: true as const,
    };
  }

  private registerMockDocumentReference(blocks: BrowserContentBlock[], pageType: MockDocumentReference['pageType']): string {
    const ref = `d${this.browser.revision}-${this.contentSessionId}-${++this.documentReferenceIndex}`;
    this.documentReferences.set(ref, {
      blocks: JSON.parse(JSON.stringify(blocks)) as BrowserContentBlock[],
      sourceRefs: blocks.map(block => block.ref),
      revision: this.browser.revision,
      url: this.browser.url ?? 'about:blank',
      title: this.browser.title ?? '',
      pageType,
      capturedAt: new Date().toISOString(),
      sourceTruncated: false,
    });
    return ref;
  }

  private resolveElementReference(ref: string): MockBrowserElement | undefined {
    const queryRef = ref.match(/^e(\d+)-q([1-9]\d*)$/u);
    if (queryRef) {
      if (Number(queryRef[1]) !== this.browser.revision) return undefined;
      return this.queryElementReferences.get(ref);
    }
    const elementRef = ref.match(/^e(\d+)-([1-9]\d*)$/u);
    if (!elementRef || Number(elementRef[1]) !== this.browser.revision) return undefined;
    return this.browser.elements[Number(elementRef[2]) - 1];
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
    this.queryElementReferences.clear();
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
    const transientFailure = this.navigationFailuresAfterReach[requestedUrl];
    if (transientFailure) {
      throw new GuestTransportError('BROWSER_NAVIGATION_FAILED', transientFailure, {
        details: { url, title, revision, navigationOccurred: true },
      });
    }
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
