import { describe, expect, it } from 'bun:test';

import {
  browserUrlsMatch,
  completionCriterionSchema,
  guestResponseSchema,
  normalizeBrowserUrl,
  parseGuestRequest,
  webSocketEventSchema,
} from '@helm/shared';

describe('shared protocol schemas', () => {
  it('parses valid guest requests and rejects unknown or malformed methods', () => {
    expect(parseGuestRequest({
      id: 'request-1',
      method: 'fs.write',
      params: { path: '/home/helm/workspace/demo.txt', content: 'hello' },
    })).toEqual({
      id: 'request-1',
      method: 'fs.write',
      params: { path: '/home/helm/workspace/demo.txt', content: 'hello' },
    });
    expect(parseGuestRequest({
      id: 'request-mkdir',
      method: 'fs.mkdir',
      params: { path: '/home/helm/Desktop/helm-demo' },
    })).toMatchObject({
      method: 'fs.mkdir',
      params: { path: '/home/helm/Desktop/helm-demo' },
    });
    expect(() => parseGuestRequest({ id: 'request-2', method: 'not-a-method', params: {} })).toThrow(/Unknown guest method/);
    expect(() => parseGuestRequest({ id: 'request-3', method: 'browser.click', params: {} })).toThrow();
  });

  it('validates guest responses and event envelopes', () => {
    expect(guestResponseSchema.safeParse({ id: 'request-1', ok: true, result: { exists: true } }).success).toBe(true);
    expect(guestResponseSchema.safeParse({ id: 'request-1', ok: false, error: { code: 'FAILED', message: 'nope' } }).success).toBe(true);
    expect(webSocketEventSchema.safeParse({
      type: 'run.completed',
      timestamp: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      payload: { complete: true },
    }).success).toBe(true);
    expect(webSocketEventSchema.safeParse({ type: 'run.completed', timestamp: 'not-a-date', payload: {} }).success).toBe(false);
  });

  it('accepts hostname shorthand and compares it with the canonical browser URL', () => {
    expect(normalizeBrowserUrl('twlite.dev')).toBe('https://twlite.dev/');
    expect(browserUrlsMatch('https://twlite.dev/', 'twlite.dev')).toBe(true);
    expect(completionCriterionSchema.safeParse({ type: 'browser.url', url: 'twlite.dev' }).success).toBe(true);
  });
});
