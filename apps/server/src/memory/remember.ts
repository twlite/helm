import type { Memory } from '@helm/shared';

import type { CreateMemoryInput } from './repository';

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_URL_PUNCTUATION = /[.,!?;:)}\]]+$/u;
const MAX_AUTOMATIC_MEMORY_LENGTH = 4_000;

function normalizeMessage(content: string): string {
  return content.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

function hasAny(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}

function hasExplicitMemoryIntent(content: string): boolean {
  return hasAny(content, /\b(?:remember|memorize|keep (?:this|that) in mind|for (?:the )?future|from now on|do not (?:use|open|repeat)|don't (?:use|open|repeat)|never (?:use|open|repeat))\b/iu);
}

function hasCorrectionIntent(content: string, hasUrl: boolean): boolean {
  if (!hasUrl) return false;
  return hasAny(content, /\b(?:actually|correct|correctly|right|actual|wrong|instead|remember|future|from now|do not|don't)\b/iu);
}

/** Avoid spending a model request on clearly ephemeral one-off chat. */
export function shouldAttemptModelMemoryExtraction(content: string): boolean {
  const normalized = normalizeMessage(content);
  return /\b(?:prefer|preference|always|never|from (?:now|the future)|my (?:name|timezone|language|location|project)|our (?:project|repo|repository|workspace)|we use|i (?:use|like|prefer)|the (?:project|repo|repository|workspace)\b)/iu.test(normalized);
}

function memoryKind(content: string, correction: boolean): Memory['kind'] {
  if (correction) return 'instruction';
  if (hasAny(content, /\b(?:i like|i prefer|my preference|i usually|prefer|preference)\b/iu)) return 'preference';
  if (hasAny(content, /\b(?:always|never|from now on|do not|don't)\b/iu)) return 'instruction';
  return 'fact';
}

/**
 * Extract only user messages that clearly ask Helm to retain something.
 *
 * This preserves important user values as a fallback when the model is
 * unavailable. The normal path asks the model to turn it into a concise,
 * standalone memory before it is persisted.
 */
export function extractExplicitMemory(
  content: string,
  relatedContext: readonly string[] = [],
): CreateMemoryInput | undefined {
  const normalized = normalizeMessage(content);
  if (normalized.length === 0) return undefined;

  const urls = [...normalized.matchAll(URL_PATTERN)].map(match => (
    match[0].replace(TRAILING_URL_PUNCTUATION, '')
  ));
  const hasUrl = urls.length > 0;
  const explicit = hasExplicitMemoryIntent(normalized);
  const correction = hasCorrectionIntent(normalized, hasUrl);
  if (!explicit && !correction) return undefined;

  const context = relatedContext
    .map(normalizeMessage)
    .filter(Boolean)
    .slice(-2)
    .join(' | ');
  const correctedSubject = normalizeMessage(
    normalized
      .replace(URL_PATTERN, ' ')
      .replace(/\b(?:oops|actually|remember|this|for the future|could you|please)\b/giu, ' '),
  );
  const topic = [context, correctedSubject]
    .filter(Boolean)
    .join(' | ')
    .slice(0, 1_000);
  const fallbackContent = correction && urls.length > 0
    ? topic.length > 0
      ? `For requests about ${topic}, use ${urls[0]} as the official source.`
      : `Use ${urls[0]} as the corrected official source for future relevant requests.`
    : `Apply this durable instruction in relevant future tasks: ${normalized}`;
  const memoryContent = fallbackContent.length <= MAX_AUTOMATIC_MEMORY_LENGTH
    ? fallbackContent
    : `${fallbackContent.slice(0, MAX_AUTOMATIC_MEMORY_LENGTH - 3).trimEnd()}...`;
  return {
    content: memoryContent,
    kind: memoryKind(normalized, correction),
    importance: correction ? 0.95 : 0.85,
  };
}
