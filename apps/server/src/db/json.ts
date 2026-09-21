import type { JsonObject, JsonValue } from '@helm/shared';

/**
 * JSON encoding used for values persisted in SQLite.
 *
 * Object keys are ordered recursively so serialized operational traces are
 * deterministic, which makes migrations, tests, and later replay tooling much
 * easier to reason about.
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const normalized = normalizeJson(value, seen, '$');
  const encoded = JSON.stringify(normalized);
  return encoded === undefined ? 'null' : encoded;
}

function normalizeJson(value: unknown, seen: WeakSet<object>, path: string): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'bigint') {
    throw new TypeError(`Cannot serialize bigint at ${path}`);
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== 'object') {
    throw new TypeError(`Cannot serialize value at ${path}`);
  }

  if (seen.has(value)) {
    throw new TypeError(`Cannot serialize circular value at ${path}`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item, index) => {
      const normalized = normalizeJson(item, seen, `${path}[${index}]`);
      return normalized === undefined ? null : normalized;
    });
    seen.delete(value);
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = normalizeJson((value as Record<string, unknown>)[key], seen, `${path}.${key}`);
    if (normalized !== undefined) {
      result[key] = normalized;
    }
  }
  seen.delete(value);
  return result;
}

export function parseJson<T>(value: string, field = 'JSON value'): T {
  try {
    return JSON.parse(value) as T;
  } catch (error) {
    throw new Error(`Invalid ${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function jsonObject(value: unknown, field = 'JSON object'): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be a JSON object`);
  }
  return value as JsonObject;
}

export function jsonValue(value: unknown, field = 'JSON value'): JsonValue {
  const encoded = stableStringify(value);
  return parseJson<JsonValue>(encoded, field);
}
