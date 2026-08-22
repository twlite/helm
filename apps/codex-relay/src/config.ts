const DEFAULT_MAX_BODY_BYTES = 16 * 1024 * 1024;
const DEFAULT_SESSION_TTL_MS = 30 * 60 * 1000;

const readPositiveInt = (name: string, fallback: number): number => {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
};

const readOptionalString = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value || undefined;
};

export const config = {
  codexBin: process.env.CODEX_BIN?.trim() || 'codex',
  debug:
    process.env.RELAY_DEBUG === '1' ||
    process.env.RELAY_DEBUG?.trim().toLowerCase() === 'true',
  codexModel: readOptionalString('CODEX_MODEL') ?? 'gpt-5.6-luna',
  host: process.env.HOST?.trim() || '127.0.0.1',
  maxBodyBytes: readPositiveInt('RELAY_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
  port: readPositiveInt('PORT', 8787),
  relayToken: readOptionalString('RELAY_TOKEN'),
  sessionTtlMs: readPositiveInt('RELAY_SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS),
};
