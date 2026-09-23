import type { Message } from '@helm/shared';

const MAX_QUERY_CHARACTERS = 3_000;
const MAX_RECENT_MESSAGES = 4;
const MAX_MESSAGE_CHARACTERS = 650;

function bounded(value: string, length: number): string {
  const normalized = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1).trimEnd()}…`;
}

/**
 * Build a short retrieval query from the latest request and nearby subject.
 * It intentionally ignores old thread history and tool traces.
 */
export function buildMemoryRetrievalQuery(
  currentRequest: string,
  conversation: readonly Message[] = [],
): string {
  const current = bounded(currentRequest, 1_600);
  const parts = [`Current request: ${current}`];
  const recent = conversation
    .filter(message => (message.role === 'user' || message.role === 'assistant') && message.content.trim().length > 0)
    .filter(message => !(message.role === 'user' && message.content.trim() === currentRequest.trim()))
    .slice(-MAX_RECENT_MESSAGES);
  for (const message of recent) {
    const content = bounded(message.content, MAX_MESSAGE_CHARACTERS);
    const part = `${message.role === 'user' ? 'Recent user context' : 'Recent assistant result'}: ${content}`;
    if (parts.join('\n').length + part.length + 1 > MAX_QUERY_CHARACTERS) break;
    parts.push(part);
  }
  return parts.join('\n');
}
