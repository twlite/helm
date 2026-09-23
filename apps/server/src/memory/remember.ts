function normalizeMessage(content: string): string {
  return content.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}

/** Avoid an optional passive extraction request for clearly ephemeral chat. */
export function shouldAttemptModelMemoryExtraction(content: string): boolean {
  const normalized = normalizeMessage(content);
  return /\b(?:prefer|preference|always|never|from (?:now|the future)|my (?:name|timezone|language|location|project)|our (?:project|repo|repository|workspace)|we use|i (?:use|like|prefer)|the (?:project|repo|repository|workspace)\b)/iu.test(normalized);
}
