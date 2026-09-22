import type { CompletionCriterion } from '@helm/shared';

/** Internal criterion used when a web-research request has no single URL to verify. */
export const BROWSER_RESEARCH_CRITERION_ID = 'browser.research';

const CURRENT_INFORMATION_PATTERN = /\b(?:today|today's|tonight|currently|current(?:ly)?|right now|latest|recent(?:ly)?|live|real[- ]?time|as of|up[- ]?to[- ]?date|this (?:morning|week|month|year))\b/iu;
const VOLATILE_WEB_TOPIC_PATTERN = /\b(?:exchange rate|currency rate|price(?:s)?|weather|forecast|news|headline|stock(?:s)?|share price|market|schedule|score|availability|opening hours|status)\b/iu;
const WEB_LOOKUP_INTENT_PATTERN = /\b(?:find|look\s*(?:up|for)|lookup|search|check|verify|research|see\s+what|according to|defined by|reported by|tell me|show me|what(?:'s| is)|how much|from the (?:official )?(?:website|site)|on the (?:official )?(?:website|site))\b/iu;
const EXPLICIT_WEB_SOURCE_PATTERN = /\b(?:browser|web|website|site|online|internet|duckduckgo|google|bing|search engine)\b/iu;
const CLEAR_CONVERSATION_PATTERN = /^(?:hi|hello|hey|good morning|good afternoon|good evening|who are you|what can you do|what is helm|tell me about yourself|how are you|thanks|thank you)[?.!, ]*$/iu;

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
    goal: `Use Helm's browser to search for and read the relevant public web pages for this request, prioritizing any named source. After opening a search-results page, inspect the results and open the most relevant result site before reporting its evidence; do not repeat the same search navigation: ${request}`,
    criteria: [browserResearchCriterion()],
  };
}

/** Start research at an explicit URL, or at a web search when the request has no URL. */
export function browserResearchStartUrl(input: string): string {
  const normalized = input.trim().replace(/[),.;!?]+$/u, '');
  const explicitUrl = normalized.match(/https?:\/\/[^\s"'<>]+/iu)?.[0];
  if (explicitUrl) return explicitUrl;
  if (/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s]*)?$/iu.test(normalized)) {
    return `https://${normalized}`;
  }
  const githubRepository = normalized.match(/(?<![~/])\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\b/u)?.[1];
  if (githubRepository && /\bgithub\b/iu.test(normalized)) {
    return `https://github.com/${githubRepository}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(input.trim())}`;
}

const SEARCH_ENGINE_HOSTS = new Set([
  'bing.com',
  'duckduckgo.com',
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

export function isSearchEngineUrl(value: string | undefined): boolean {
  const url = value === undefined ? undefined : parsedHttpUrl(value);
  return url !== undefined && searchEngineHost(url.hostname);
}

export function isSearchResultsUrl(value: string | undefined): boolean {
  const url = value === undefined ? undefined : parsedHttpUrl(value);
  if (url === undefined || !searchEngineHost(url.hostname)) return false;
  return url.searchParams.has('q') || /\/search(?:\/|$)/iu.test(url.pathname);
}

function searchQuery(value: string): string | undefined {
  const url = parsedHttpUrl(value);
  if (url === undefined || !searchEngineHost(url.hostname)) return undefined;
  const query = url.searchParams.get('q') ?? url.searchParams.get('query');
  return query?.trim().replace(/\s+/gu, ' ').toLocaleLowerCase() || undefined;
}

/** Whether a navigation points back to the same search, or to its home page. */
export function isSameSearchNavigation(current: string | undefined, target: string | undefined): boolean {
  if (!current || !target || !isSearchResultsUrl(current) || !isSearchEngineUrl(target)) return false;
  const currentQuery = searchQuery(current);
  const targetQuery = searchQuery(target);
  return currentQuery !== undefined && (targetQuery === undefined || targetQuery === currentQuery);
}
