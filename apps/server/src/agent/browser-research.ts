import type { CompletionCriterion } from '@helm/shared';

/** Internal criterion used when a web-research request has no single URL to verify. */
export const BROWSER_RESEARCH_CRITERION_ID = 'browser.research';

const CURRENT_INFORMATION_PATTERN = /\b(?:today|today's|tonight|currently|current(?:ly)?|right now|latest|recent(?:ly)?|live|real[- ]?time|as of|up[- ]?to[- ]?date|this (?:morning|week|month|year))\b/iu;
const VOLATILE_WEB_TOPIC_PATTERN = /\b(?:exchange rate|currency rate|price(?:s)?|weather|forecast|news|headline|stock(?:s)?|share price|market|schedule|score|availability|opening hours|status)\b/iu;
const WEB_LOOKUP_INTENT_PATTERN = /\b(?:find|look\s*up|lookup|search|check|verify|research|according to|defined by|reported by|tell me|show me|what(?:'s| is)|how much|from the (?:official )?(?:website|site)|on the (?:official )?(?:website|site))\b/iu;
const CLEAR_CONVERSATION_PATTERN = /^(?:hi|hello|hey|good morning|good afternoon|good evening|who are you|what can you do|what is helm|tell me about yourself|how are you|thanks|thank you)[?.!, ]*$/iu;

/**
 * Detect requests that require fresh public web information.
 *
 * This intentionally does not classify ordinary questions as web research.
 * It only catches a volatile topic or explicit current-information language
 * together with a lookup/research intent, leaving the model planner in charge
 * of all other task classification.
 */
export function isBrowserResearchRequest(input: string): boolean {
  const normalized = input.trim().replace(/\s+/gu, ' ');
  if (!normalized || CLEAR_CONVERSATION_PATTERN.test(normalized)) return false;

  const hasCurrentSignal = CURRENT_INFORMATION_PATTERN.test(normalized);
  const hasVolatileTopic = VOLATILE_WEB_TOPIC_PATTERN.test(normalized);
  const hasLookupIntent = WEB_LOOKUP_INTENT_PATTERN.test(normalized);
  return (hasCurrentSignal && hasLookupIntent) || (hasVolatileTopic && hasLookupIntent);
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
    goal: `Use Helm's browser to find and read current public web information for this request, prioritizing any named official source, then report the evidence: ${request}`,
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
  return `https://www.google.com/search?q=${encodeURIComponent(input.trim())}`;
}
