import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import { guestMethodSchemas, modelToolSchemas } from '../src/schemas';
import { assertNestedDeadlines, GUEST_TOOL_DEADLINES_MS, GUEST_VM_HOST_GRACE_MS, guestRpcTimeoutFor } from '../src/tool-timeouts';

describe('guest tool schemas', () => {
  it('separates page-level semantic reads from ref-level pagination', () => {
    expect(guestMethodSchemas['browser.read'].safeParse({
      mode: 'readable', query: 'body', maxBlocks: 3, maxChars: 2_000,
    }).success).toBe(true);
    expect(guestMethodSchemas['browser.read'].safeParse({
      mode: 'document', limit: 20,
    }).success).toBe(false);
    expect(guestMethodSchemas['browser.read'].safeParse({
      mode: 'document', blockTypes: ['table'], maxBlocks: 20,
    }).success).toBe(true);
    expect(guestMethodSchemas['browser.read'].safeParse({
      offset: 10,
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
    expect(guestMethodSchemas['browser.read'].safeParse({
      ref: 'd1-12345678-1', mode: 'document',
    }).success).toBe(false);
  });

  it('makes fs.write source serialization explicit and model-authored writes direct', () => {
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', content: 'Notes.' }).success).toBe(true);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', sourceRef: 'd1-12345678-1', format: 'text' }).success).toBe(true);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', content: 'Notes.', format: 'text' }).success).toBe(false);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', content: 'Notes.', sourceRef: 'c1-12345678-1' }).success).toBe(false);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt' }).success).toBe(false);
    expect(guestMethodSchemas['fs.write'].safeParse({ path: 'notes.txt', sourceRef: 'c1-12345678-1', content: 'Notes.' }).success).toBe(false);
  });

  it('exposes unambiguous model-facing write schemas with no content/sourceRef XOR', () => {
    expect(modelToolSchemas['fs.writeText'].safeParse({ path: 'notes.txt', content: 'Notes.' }).success).toBe(true);
    expect(modelToolSchemas['fs.writeText'].safeParse({ path: 'notes.txt', content: 'Notes.', sourceRef: 'c1-12345678-1' }).success).toBe(false);
    expect(modelToolSchemas['fs.writeFromRef'].safeParse({
      path: 'rates.txt', sourceRef: 'd1-12345678-1', format: 'text',
    }).success).toBe(true);
    expect(modelToolSchemas['fs.writeFromRef'].safeParse({
      path: 'rates.txt', sourceRef: 'd1-12345678-1', content: 'Notes.',
    }).success).toBe(false);
    for (const schema of Object.values(modelToolSchemas)) {
      const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;
      expect(jsonSchema.type).toBe('object');
      expect(jsonSchema.anyOf).toBeUndefined();
      expect(jsonSchema.oneOf).toBeUndefined();
      expect(jsonSchema.not).toBeUndefined();
    }
  });

  it('keeps every bounded guest operation inside its RPC, host, and server deadlines', () => {
    for (const [name, deadlines] of Object.entries(GUEST_TOOL_DEADLINES_MS)) {
      expect(assertNestedDeadlines(deadlines), name).toBe(true);
      expect(deadlines.hostCommand - deadlines.guestRpc, name).toBe(GUEST_VM_HOST_GRACE_MS);
    }
    expect(GUEST_TOOL_DEADLINES_MS.browserNavigate).toEqual({
      pageNavigation: 30_000, operation: 40_000, guestRpc: 45_000, hostCommand: 50_000, serverTool: 55_000,
    });
    expect(GUEST_TOOL_DEADLINES_MS.browserNavigate.pageNavigation).toBeLessThan(GUEST_TOOL_DEADLINES_MS.browserNavigate.operation);
    expect(GUEST_TOOL_DEADLINES_MS.browserNavigate.guestRpc).toBeGreaterThan(GUEST_TOOL_DEADLINES_MS.browserNavigate.operation);
    expect(guestRpcTimeoutFor('browser.navigate')).toBe(GUEST_TOOL_DEADLINES_MS.browserNavigate.guestRpc);
    expect(guestRpcTimeoutFor('browser.getState')).toBe(GUEST_TOOL_DEADLINES_MS.browserInspection.guestRpc);
  });
});
