import { describe, expect, it } from 'bun:test';
import { guestMethodSchemas } from '../src/schemas';

describe('guest tool schemas', () => {
  it('separates page-level semantic reads from ref-level pagination', () => {
    expect(guestMethodSchemas['browser.read'].safeParse({
      mode: 'readable', query: 'body', maxBlocks: 3, maxChars: 2_000,
    }).success).toBe(true);
    expect(guestMethodSchemas['browser.read'].safeParse({
      mode: 'document', limit: 20,
    }).success).toBe(false);
    expect(guestMethodSchemas['browser.read'].safeParse({
      ref: 'c1-12345678-1', offset: 10, limit: 5, maxChars: 2_000,
    }).success).toBe(true);
    expect(guestMethodSchemas['browser.read'].safeParse({
      ref: 'd1-12345678-1', offset: 1, limit: 2,
    }).success).toBe(true);
    expect(guestMethodSchemas['browser.read'].safeParse({
      ref: 'c1-12345678-1', query: 'currency',
    }).success).toBe(false);
  });

  it('makes fs.write source serialization explicit and model-authored writes direct', () => {
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', content: 'Notes.' }).success).toBe(true);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', sourceRef: 'd1-12345678-1', format: 'text' }).success).toBe(true);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', content: 'Notes.', format: 'text' }).success).toBe(false);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', content: 'Notes.', sourceRef: 'c1-12345678-1' }).success).toBe(false);
  });
});
