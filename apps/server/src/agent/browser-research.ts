import type { CompletionCriterion } from '@helm/shared';

/** Internal criterion used when a web-research request has no single URL to verify. */
export const BROWSER_RESEARCH_CRITERION_ID = 'browser.research';

const CURRENT_INFORMATION_PATTERN = /\b(?:today|today's|tonight|currently|current(?:ly)?|right now|latest|recent(?:ly)?|live|real[- ]?time|as of|up[- ]?to[- ]?date|this (?:morning|week|month|year))\b/iu;
const VOLATILE_WEB_TOPIC_PATTERN = /\b(?:exchange rate|currency rate|price(?:s)?|weather|forecast|news|headline|stock(?:s)?|share price|market|schedule|score|availability|opening hours|status)\b/iu;
const WEB_LOOKUP_INTENT_PATTERN = /\b(?:find|look\s*(?:up|for)|lookup|search|check|verify|research|fetch|retrieve|download|visit|open|navigate|go to|see\s+what|according to|defined by|reported by|tell me|show me|what(?:'s| is)|how much|from the (?:official )?(?:website|site)|on the (?:official )?(?:website|site))\b/iu;
const EXPLICIT_WEB_SOURCE_PATTERN = /\b(?:browser|web|website|site|online|internet|duckduckgo|google|bing|search engine)\b/iu;
const CLEAR_CONVERSATION_PATTERN = /^(?:hi|hello|hey|good morning|good afternoon|good evening|who are you|what can you do|what is helm|tell me about yourself|how are you|thanks|thank you)[?.!, ]*$/iu;
const DUCKDUCKGO_SEARCH_URL = 'https://duckduckgo.com';
const SUPPORTED_BROWSER_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:']);
const BARE_FILE_REFERENCE_PATTERN = /\.(?:txt|md|markdown|json|csv|tsv|log|html?|css|js|jsx|mjs|cjs|ts|tsx|xml|ya?ml|toml|ini|conf|env|pdf|docx?|xlsx?|pptx?|zip|tar|gz)(?:[?#].*)?$/iu;
const STATIC_IMAGE_URL_PATTERN = /\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp|tiff?)(?:[?#].*)?$/iu;
const ASSET_CONTEXT_PATTERN = /\b(?:image|picture|photo|avatar|profile\s+(?:picture|image|photo)|logo|icon|thumbnail|background|cover|src|href)\b/iu;
const EXPLICIT_NAVIGATION_PATTERN = /\b(?:go\s+to|navigate(?:\s+to)?|visit|open|browse|read|inspect|research|look\s+(?:it\s+)?up|find(?:\s+out)?|extract|download)\b/iu;

/**
 * Detect requests that require public web research.
 *
 * Ordinary questions remain conversational. Explicit web/search-engine
 * instructions are research even when the user did not say "today" or
 * "current"; otherwise the decision model can get stuck navigating a search
 * page without being required to read it.
 */
export function isBrowserResearchRequest(input: string): boolean {
  const normalized = input.trim().replace(/\s+/gu, ' ');
  if (!normalized || CLEAR_CONVERSATION_PATTERN.test(normalized)) return false;

  const hasCurrentSignal = CURRENT_INFORMATION_PATTERN.test(normalized);
  const hasVolatileTopic = VOLATILE_WEB_TOPIC_PATTERN.test(normalized);
  const hasLookupIntent = WEB_LOOKUP_INTENT_PATTERN.test(normalized);
  const hasExplicitWebSource = EXPLICIT_WEB_SOURCE_PATTERN.test(normalized);
  return (
    (hasCurrentSignal && hasLookupIntent)
    || (hasVolatileTopic && hasLookupIntent)
    || (hasExplicitWebSource && hasLookupIntent)
  );
}

export function browserResearchCriterion(): CompletionCriterion {
  return {
    type: 'custom',
    id: BROWSER_RESEARCH_CRITERION_ID,
    description: 'Read current public web information with the browser before answering.',
  };
}

export function browserResearchTask(input: { threadId: string; userMessage: string }): {
  id: string;
  threadId: string;
  goal: string;
  criteria: CompletionCriterion[];
} {
  const request = input.userMessage.trim();
  return {
    id: `ai-browser-research-${input.threadId}`,
    threadId: input.threadId,
    goal: `Use Helm's browser to search with DuckDuckGo and read the relevant public web pages for this request, prioritizing any named source and relevant memory guidance. If the user did not supply an exact destination URL and memory does not contain an exact verified URL, search DuckDuckGo first; never infer a website hostname or route. Use semantic browser.search/read results and browser.open({ ref }) to follow the selected result's observed href without retyping it. An exact verified-memory URL may be opened directly, but if it fails or redirects unexpectedly, search DuckDuckGo again. DuckDuckGo is the only supported search engine. Do not repeat the same search navigation: ${request}`,
    criteria: [browserResearchCriterion()],
  };
}

/** Start research at an explicit URL, or at a web search when the request has no URL. */
export function explicitBrowserUrls(input: string): string[] {
  const candidates: string[] = [];
  const add = (value: string, allowBareHost = false): void => {
    const clean = value.trim().replace(/[),.;!?]+$/u, '');
    const hasScheme = /^[a-z][a-z0-9+.-]*:/iu.test(clean);
    if (!clean || (!hasScheme && BARE_FILE_REFERENCE_PATTERN.test(clean))) return;
    const withScheme = hasScheme
      ? clean
      : allowBareHost ? `https://${clean}` : undefined;
    if (!withScheme) return;
    try {
      const parsed = new URL(withScheme);
      if (['http:', 'https:', 'file:', 'about:'].includes(parsed.protocol)) candidates.push(parsed.href);
    } catch {
      // An incomplete URL is not a destination.
    }
  };

  for (const match of input.matchAll(/\bhttps?:\/\/[^\s"'<>]+/giu)) add(match[0]);
  for (const match of input.matchAll(/\b(?:file|about):(?:\/\/)?[^\s"'<>]+/giu)) add(match[0]);
  // An unprefixed hostname/path written explicitly by the user is still an
  // observed destination. Ordinary organization names do not match this form.
  for (const match of input.matchAll(/(?:^|[\s("'<>])((?:www\.)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s"'<>]*)?)/giu)) {
    add(match[1] ?? '', true);
  }
  return [...new Set(candidates)];
}

/** Explicit URLs that the user supplied as destinations, excluding obvious asset values. */
export function explicitBrowserNavigationUrls(input: string): string[] {
  return explicitBrowserUrls(input).filter(url => {
    const withoutScheme = url.replace(/^https?:\/\//iu, '');
    const start = input.toLocaleLowerCase().indexOf(withoutScheme.toLocaleLowerCase());
    const before = start >= 0 ? input.slice(Math.max(0, input.lastIndexOf('.', start) + 1), start) : '';
    const end = start < 0 ? -1 : start + withoutScheme.length;
    const terminators = end < 0 ? [] : ['.', '!', '?', '\n']
      .map(marker => input.indexOf(marker, end))
      .filter(index => index >= 0);
    const after = end < 0
      ? ''
      : input.slice(end, terminators.length > 0 ? Math.min(...terminators) : input.length);
    const context = `${before}${withoutScheme}${after}`;
    const clauseBeforeUrl = before.split(/\b(?:and|but|then|using|use|as)\b/iu).at(-1) ?? before;
    const explicitlyOpened = EXPLICIT_NAVIGATION_PATTERN.test(clauseBeforeUrl);
    const hasAssetContext = ASSET_CONTEXT_PATTERN.test(context);
    const imageAsset = STATIC_IMAGE_URL_PATTERN.test(url);
    return explicitlyOpened || (!hasAssetContext && !imageAsset);
  });
}

export function browserResearchSearchUrl(query: string): string {
  return duckDuckGoSearchUrl(query);
}

/** Use only a destination explicitly written by the user; otherwise start at DuckDuckGo. */
export function browserResearchStartUrl(input: string): string {
  const explicit = explicitBrowserUrls(input).find(value => /^https?:/iu.test(value));
  if (explicit) return normalizeUnsupportedSearchEngineUrl(explicit) ?? explicit;
  const nonHttp = input.match(/\b(?:file|about):(?:\/\/)?[^\s"'<>]+/iu)?.[0];
  if (nonHttp) return nonHttp;
  return duckDuckGoSearchUrl(input.trim());
}

/**
 * Model-proposed browser navigations must already be URLs. Compiled task
 * sources are normalized separately, so accepting a bare model string here
 * would turn output names such as `report.html` into browser destinations.
 */
export function isAbsoluteBrowserNavigationUrl(input: string): boolean {
  try {
    return SUPPORTED_BROWSER_PROTOCOLS.has(new URL(input.trim()).protocol);
  } catch {
    return false;
  }
}

const SEARCH_ENGINE_HOSTS = new Set([
  'duckduckgo.com',
]);

/** Hosts that Helm recognizes as search engines only for redirecting them to DuckDuckGo. */
const UNSUPPORTED_SEARCH_ENGINE_HOSTS = new Set([
  'bing.com',
  'google.com',
]);

function parsedHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}

function searchEngineHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase();
  return [...SEARCH_ENGINE_HOSTS].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function unsupportedSearchEngineHost(hostname: string): boolean {
  const host = hostname.toLocaleLowerCase();
  return [...UNSUPPORTED_SEARCH_ENGINE_HOSTS].some(domain => host === domain || host.endsWith(`.${domain}`));
}

function searchResultsPath(url: URL): boolean {
  return url.searchParams.has('q')
    || url.searchParams.has('query')
    || /\/(?:search|results)(?:\/|$)/iu.test(url.pathname);
}

function queryFromSearchUrl(url: URL): string | undefined {
  const query = url.searchParams.get('q') ?? url.searchParams.get('query');
  return query?.trim() || undefined;
}

function duckDuckGoSearchUrl(query: string): string {
  return `${DUCKDUCKGO_SEARCH_URL}/?q=${encodeURIComponent(query.trim())}`;
}

function normalizeUnsupportedSearchEngineUrl(value: string): string | undefined {
  const url = parsedHttpUrl(value);
  if (url === undefined || !unsupportedSearchEngineHost(url.hostname)) return undefined;

  const query = searchResultsPath(url) ? queryFromSearchUrl(url) : undefined;
  return query === undefined ? DUCKDUCKGO_SEARCH_URL : duckDuckGoSearchUrl(query);
}

export function isUnsupportedSearchEngineUrl(value: string | undefined): boolean {
  const url = value === undefined ? undefined : parsedHttpUrl(value);
  return url !== undefined
    && unsupportedSearchEngineHost(url.hostname)
    && searchResultsPath(url);
}

export function isSearchEngineUrl(value: string | undefined): boolean {
  const url = value === undefined ? undefined : parsedHttpUrl(value);
  return url !== undefined && searchEngineHost(url.hostname);
}

export function isSearchResultsUrl(value: string | undefined): boolean {
  const url = value === undefined ? undefined : parsedHttpUrl(value);
  if (url === undefined || !searchEngineHost(url.hostname)) return false;
  return searchResultsPath(url);
}

function searchQuery(value: string): string | undefined {
  const url = parsedHttpUrl(value);
  if (url === undefined || !searchEngineHost(url.hostname)) return undefined;
  return queryFromSearchUrl(url)?.replace(/\s+/gu, ' ').toLocaleLowerCase() || undefined;
}

/** Whether a navigation points back to the same search, or to its home page. */
export function isSameSearchNavigation(current: string | undefined, target: string | undefined): boolean {
  if (!current || !target || !isSearchResultsUrl(current) || !isSearchEngineUrl(target)) return false;
  const currentQuery = searchQuery(current);
  const targetQuery = searchQuery(target);
  return currentQuery !== undefined && (targetQuery === undefined || targetQuery === currentQuery);
}
