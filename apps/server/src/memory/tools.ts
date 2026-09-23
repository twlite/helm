import { z } from 'zod';

import type { Memory, MemoryDurability, MemorySource, ToolResult } from '@helm/shared';

import type { ToolRegistry } from '../tools/tool-registry';
import type { MemoryService } from './service';

const memoryKindSchema = z.enum(['fact', 'preference', 'instruction', 'note']);
const sourceUrlSchema = z.string().url().max(4_000).refine(value => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  } catch {
    return false;
  }
}, 'Expected an HTTP or HTTPS URL without credentials.');
const evidenceIdsSchema = z.array(z.string().trim().min(1).max(200)).max(20);

const memorySearchSchema = z.object({
  query: z.string().trim().min(1).max(1_000),
  limit: z.number().int().min(1).max(20).default(8),
}).strict();

const memoryRememberSchema = z.object({
  content: z.string().trim().min(1).max(4_000),
  kind: memoryKindSchema,
  key: z.string().trim().min(1).max(200).optional(),
  importance: z.number().min(0).max(1).default(0.7),
  source: z.enum(['user', 'observed'] satisfies [MemorySource, ...MemorySource[]]).default('user'),
  sourceUrl: sourceUrlSchema.optional(),
  evidenceIds: evidenceIdsSchema.optional(),
  durability: z.enum(['durable', 'refreshable'] satisfies [MemoryDurability, ...MemoryDurability[]]).optional(),
}).strict();

const memoryUpdateSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  key: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(4_000).optional(),
  kind: memoryKindSchema.optional(),
  importance: z.number().min(0).max(1).optional(),
  source: z.enum(['user', 'observed'] satisfies [MemorySource, ...MemorySource[]]).optional(),
  sourceUrl: sourceUrlSchema.optional(),
  evidenceIds: evidenceIdsSchema.optional(),
  durability: z.enum(['durable', 'refreshable'] satisfies [MemoryDurability, ...MemoryDurability[]]).optional(),
}).strict().refine(value => Boolean(value.id) !== Boolean(value.key), 'Provide exactly one of id or key.')
  .refine(value => Object.keys(value).some(key => !['id', 'key'].includes(key)), 'Provide at least one memory field to update.');

const memoryForgetSchema = z.object({
  id: z.string().trim().min(1).max(200).optional(),
  key: z.string().trim().min(1).max(200).optional(),
}).strict().refine(value => Boolean(value.id) !== Boolean(value.key), 'Provide exactly one of id or key.');

function compactMemory(memory: Memory): Record<string, unknown> {
  return {
    id: memory.id,
    ...(memory.key ? { key: memory.key } : {}),
    kind: memory.kind,
    content: memory.content.length <= 2_000 ? memory.content : `${memory.content.slice(0, 1_997).trimEnd()}...`,
    importance: memory.importance,
    ...(memory.source ? { source: memory.source } : {}),
    ...(memory.sourceUrl ? { sourceUrl: memory.sourceUrl } : {}),
    ...(memory.durability ? { durability: memory.durability } : {}),
    ...(memory.lastVerifiedAt ? { lastVerifiedAt: memory.lastVerifiedAt } : {}),
    updatedAt: memory.updatedAt,
  };
}

function successfulReceiptIds(previousResults: readonly ToolResult[]): Set<string> {
  const ids = new Set<string>();
  for (const result of previousResults) {
    if (!result.ok || typeof result.evidence !== 'object' || result.evidence === null || Array.isArray(result.evidence)) continue;
    const receipt = (result.evidence as Record<string, unknown>).receipt;
    if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) continue;
    const id = (receipt as Record<string, unknown>).id;
    if (typeof id === 'string') ids.add(id);
  }
  return ids;
}

function validateObservedEvidence(
  source: MemorySource | undefined,
  requestedIds: readonly string[] | undefined,
  previousResults: readonly ToolResult[],
): ToolResult | undefined {
  if (source !== 'observed') return undefined;
  const allowed = successfulReceiptIds(previousResults);
  const ids = requestedIds ?? [];
  if (ids.length === 0) {
    return { ok: false, error: { code: 'MEMORY_EVIDENCE_REQUIRED', message: 'Observed memories require a successful tool receipt ID.' } };
  }
  const unknown = ids.filter(id => !allowed.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: {
        code: 'INVALID_MEMORY_EVIDENCE',
        message: 'Evidence IDs must belong to successful tool results from this run.',
        details: unknown,
      },
    };
  }
  return undefined;
}

function failure(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

/** Register host-side memory APIs in the same validated native tool registry. */
export function registerMemoryTools(registry: ToolRegistry, memory: MemoryService): void {
  registry.register({
    name: 'memory.search',
    description: 'Search durable memories with the same hybrid FTS and vector ranking used for automatic recall.',
    inputSchema: memorySearchSchema,
    execute: async ({ query, limit }: z.infer<typeof memorySearchSchema>) => ({
      results: (await memory.search(query, limit)).map(compactMemory),
    }),
  });
  registry.register({
    name: 'memory.remember',
    description: 'Create or update a durable memory. For information discovered with tools, use source observed and include IDs from successful tool receipts. Use a stable optional key for information that may be corrected later.',
    inputSchema: memoryRememberSchema,
    execute: async (input: z.infer<typeof memoryRememberSchema>, context) => {
      const invalidEvidence = validateObservedEvidence(input.source, input.evidenceIds, context.previousResults);
      if (invalidEvidence) return invalidEvidence;
      const result = await memory.remember({
        ...input,
        ...(input.source === 'observed' ? { lastVerifiedAt: new Date().toISOString() } : {}),
      });
      return {
        action: result.action,
        memory: compactMemory(result.memory),
      };
    },
  });
  registry.register({
    name: 'memory.update',
    description: 'Update an existing durable memory by ID or key. For a user correction, set source to user; for newly observed information, set source to observed and cite successful receipt IDs.',
    inputSchema: memoryUpdateSchema,
    execute: async (input: z.infer<typeof memoryUpdateSchema>, context) => {
      const current = input.id ? memory.get(input.id) : input.key ? memory.getByKey(input.key) : undefined;
      if (!current) return failure('MEMORY_NOT_FOUND', 'No matching memory was found to update.');
      const observationChanged = input.content !== undefined
        || input.sourceUrl !== undefined
        || input.evidenceIds !== undefined;
      const isObservedUpdate = input.source === 'observed'
        || (input.source === undefined && current.source === 'observed' && observationChanged);
      const invalidEvidence = validateObservedEvidence(
        isObservedUpdate ? 'observed' : input.source,
        input.evidenceIds,
        context.previousResults,
      );
      if (invalidEvidence) return invalidEvidence;
      const updated = await memory.update(current.id, {
        ...(input.content === undefined ? {} : { content: input.content }),
        ...(input.kind === undefined ? {} : { kind: input.kind }),
        ...(input.importance === undefined ? {} : { importance: input.importance }),
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.sourceUrl === undefined ? {} : { sourceUrl: input.sourceUrl }),
        ...(input.evidenceIds === undefined ? {} : { evidenceIds: input.evidenceIds }),
        ...(input.durability === undefined ? {} : { durability: input.durability }),
        ...(isObservedUpdate ? { lastVerifiedAt: new Date().toISOString() } : {}),
        ...(input.source === 'user' ? {
          ...(input.sourceUrl === undefined && current.source === 'observed' ? { sourceUrl: null } : {}),
          ...(input.evidenceIds === undefined ? { evidenceIds: [] } : {}),
          lastVerifiedAt: null,
        } : {}),
      });
      if (!updated) return failure('MEMORY_NOT_FOUND', 'The memory disappeared before it could be updated.');
      return { action: 'updated', memory: compactMemory(updated) };
    },
  });
  registry.register({
    name: 'memory.forget',
    description: 'Permanently delete a remembered item by ID or its stable key when the user asks Helm to forget it.',
    inputSchema: memoryForgetSchema,
    execute: async (input: z.infer<typeof memoryForgetSchema>) => {
      const deleted = await memory.forget(input);
      if (!deleted) return failure('MEMORY_NOT_FOUND', 'No matching memory was found to forget.');
      return { deleted: true, ...(input.id ? { id: input.id } : { key: input.key }) };
    },
  });
}
