const BROWSER_URL_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:']);
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/iu;
const HOST_WITH_PORT_PATTERN = /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|(?:[a-z\d](?:[a-z\d-]*\.)+[a-z\d-]+)):\d+(?:[/?#]|$)/iu;

function invalidUrl(message: string): never {
  throw new Error(message);
}

/**
 * Converts the hostname shorthand accepted by the agent into a URL that
 * browser implementations can navigate, while keeping the supported URL
 * protocol allowlist in one place.
 */
export function normalizeBrowserUrl(value: string): string {
  if (value.length > 8_192 || /[\u0000-\u001f\u007f]/.test(value)) {
    return invalidUrl('url is too long or contains control characters.');
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return invalidUrl('url must be a valid http, https, file, or about URL.');
  }

  if (
    /^[/?#]/u.test(trimmed) ||
    trimmed === '.' ||
    trimmed === '..' ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../')
  ) {
    return invalidUrl('url must be a valid http, https, file, or about URL.');
  }

  // A hostname with a numeric port (for example localhost:3000) is still
  // shorthand, not a custom URI scheme. Other explicit schemes are checked
  // against the allowlist below instead of being silently rewritten.
  const hasExplicitScheme = URL_SCHEME_PATTERN.test(trimmed);
  const isHostWithPort = HOST_WITH_PORT_PATTERN.test(trimmed);
  const candidate = !hasExplicitScheme || isHostWithPort ? `https://${trimmed}` : trimmed;

  try {
    const parsed = new URL(candidate);
    if (!BROWSER_URL_PROTOCOLS.has(parsed.protocol)) {
      return invalidUrl('url must be a valid http, https, file, or about URL.');
    }
    if ((parsed.protocol === 'http:' || parsed.protocol === 'https:') && parsed.hostname.length === 0) {
      return invalidUrl('url must be a valid http, https, file, or about URL.');
    }
    return parsed.href;
  } catch {
    return invalidUrl('url must be a valid http, https, file, or about URL.');
  }
}

/** Compare browser URLs after applying the same canonicalization as navigation. */
export function browserUrlsMatch(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) return false;

  try {
    return normalizeBrowserUrl(actual) === normalizeBrowserUrl(expected);
  } catch {
    return false;
  }
}
