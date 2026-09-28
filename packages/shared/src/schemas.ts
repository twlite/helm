import { z } from 'zod';
import { normalizeBrowserUrl } from './browser-url';
import { GUEST_PROTOCOL_VERSION } from './guest-identity';

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const guestBuildManifestSchema = z.object({
  manifestVersion: z.literal(1),
  runtime: z.literal('helm-guest'),
  buildId: sha256Schema,
  protocolVersion: z.number().int().positive(),
  protocolContractSha256: sha256Schema,
  bundleSha256: sha256Schema,
  bundleSizeBytes: z.number().int().nonnegative(),
  bunVersion: z.string().min(1),
}).strict();

export const guestHandshakeResultSchema = z.object({
  runtime: z.literal('helm-guest'),
  protocolVersion: z.number().int().positive(),
  buildId: z.string().min(1),
  protocolContractSha256: z.string().min(1),
  bundleSha256: sha256Schema.optional(),
  serverId: z.string().uuid(),
  methods: z.array(z.string().min(1)),
}).passthrough();

const pathSchema = z.string().min(1);
const browserUrlSchema = z.string().min(1).refine(
  value => {
    try {
      normalizeBrowserUrl(value);
      return true;
    } catch {
      return false;
    }
  },
  'Expected a valid browser URL or hostname.',
);

export const completionCriterionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('browser.url'), url: browserUrlSchema }),
  z.object({ type: z.literal('file.exists'), path: pathSchema }),
  z.object({ type: z.literal('file.contains'), path: pathSchema, expected: z.string() }),
  z.object({
    type: z.literal('window.open'),
    application: z.string().optional(),
    titleIncludes: z.string().optional(),
  }),
  z.object({
    type: z.literal('window.focused'),
    application: z.string().optional(),
    titleIncludes: z.string().optional(),
  }),
  z.object({ type: z.literal('custom'), id: z.string().min(1), description: z.string().min(1) }),
]);

const coordinateSchema = z.object({ x: z.number().finite(), y: z.number().finite() });
const browserContentRefSchema = z.string().regex(/^(?:c|d)\d+-[a-f0-9]{8}-[1-9]\d*$/u);
const browserContentFormatSchema = z.enum(['text', 'markdown', 'json', 'csv']);
const fsWriteSchema = z.object({
  path: pathSchema,
  content: z.string().max(50 * 1024 * 1024).optional()
    .describe('UTF-8 content authored by the model. Provide content or sourceRef, not both.'),
  sourceRef: browserContentRefSchema.optional()
    .describe('A durable browser.read block ref or documentRef. Provide sourceRef or content, not both.'),
  format: browserContentFormatSchema.optional()
    .describe('Serialization format for sourceRef. Omit for model-authored content.'),
}).strict().superRefine((value, context) => {
  const hasContent = value.content !== undefined;
  const hasSourceRef = value.sourceRef !== undefined;
  if (hasContent === hasSourceRef) {
    context.addIssue({
      code: 'custom',
      path: ['content'],
      message: 'Provide exactly one of content or sourceRef.',
    });
  }
  if (value.format !== undefined && !hasSourceRef) {
    context.addIssue({
      code: 'custom',
      path: ['format'],
      message: 'format is only valid with sourceRef.',
    });
  }
});
const browserReadSchema = z.object({
  ref: browserContentRefSchema.optional()
    .describe('Read or paginate a durable semantic content ref returned by browser.read.'),
  mode: z.enum(['readable', 'document']).optional().describe('readable ranks compact blocks; document returns a broader DOM-ordered snapshot.'),
  query: z.string().trim().min(1).max(1_000).optional().describe('Natural-language content relevance query, not a CSS selector. Use browser.query for DOM/CSS inspection.'),
  maxBlocks: z.number().int().min(1).max(20).optional().describe('Maximum semantic blocks to return from the current page.'),
  maxChars: z.number().int().min(1).max(12_000).optional().describe('Maximum response size for bounded block previews.'),
  blockTypes: z.array(z.enum(['text', 'heading', 'table', 'list', 'code', 'form', 'definition', 'navigation', 'search_result', 'other']))
    .max(10).optional().describe('Optional semantic block types to include, such as table for structured data.'),
  offset: z.number().int().min(0).max(1_000_000).optional()
    .describe('For ref reads only, start pagination at this item or row offset.'),
  limit: z.number().int().min(1).max(100).optional().describe('For a block ref, page within its rows or items; for a documentRef, page through selected blocks.'),
}).strict().superRefine((value, context) => {
  if (value.ref === undefined) {
    for (const key of ['offset', 'limit'] as const) {
      if (value[key] !== undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is only valid when reading a ref.`,
        });
      }
    }
    return;
  }

  for (const key of ['mode', 'query', 'maxBlocks', 'blockTypes'] as const) {
    if (value[key] !== undefined) {
      context.addIssue({
        code: 'custom',
        path: [key],
        message: `${key} is only valid for a page-level read without ref.`,
      });
    }
  }
});

export const guestMethodSchemas = {
  'guest.handshake': z.object({ serverId: z.string().uuid() }).strict(),
  'fs.read': z.object({ path: pathSchema }),
  'fs.write': fsWriteSchema,
  'fs.mkdir': z.object({ path: pathSchema }),
  'fs.exists': z.object({ path: pathSchema }),
  'fs.list': z.object({ path: pathSchema }),
  'fs.stat': z.object({ path: pathSchema, includeSha256: z.boolean().optional() }),
  'browser.navigate': z.object({ url: z.string().min(1) }),
  'browser.getState': z.object({}),
  'browser.snapshot': z.object({ maxRegions: z.number().int().min(1).max(100).optional() }),
  'browser.query': z.object({
    selector: z.string().trim().min(1).max(1_000).optional(),
    text: z.string().trim().min(1).max(1_000).optional(),
    role: z.string().trim().min(1).max(100).optional(),
    name: z.string().trim().min(1).max(1_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).refine(value => Boolean(value.selector || value.text || value.role || value.name), 'Provide at least one DOM query filter'),
  'browser.evaluate': z.object({ expression: z.string().trim().min(1).max(12_000) }).strict(),
  'browser.read': browserReadSchema,
  'browser.findPage': z.object({
    query: z.string().trim().min(1).max(1_000),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  'browser.webSearch': z.object({
    query: z.string().trim().min(1).max(1_000),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  'browser.open': z.object({
    ref: z.string().regex(/^(?:c\d+-[a-f0-9]{8}-[1-9]\d*|n-[a-f0-9]{8}-[1-9]\d*)$/u),
    linkIndex: z.number().int().min(0).max(1_000).optional(),
  }),
  'browser.inspectRegion': z.object({
    ref: z.string().regex(/^r\d+-[1-9]\d*$/u),
    format: z.enum(['auto', 'text', 'table', 'links']).optional(),
    maxChars: z.number().int().min(1_000).max(12_000).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  'browser.download': z.object({
    ref: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
  }).refine(
    value => Boolean(value.ref) !== Boolean(value.url),
    'Provide either ref or url',
  ),
  'browser.click': z.object({
    ref: z.string().min(1).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
  }).refine(
    value => {
      const hasX = value.x !== undefined;
      const hasY = value.y !== undefined;
      const hasCoordinates = hasX && hasY;
      return hasX === hasY && Boolean(value.ref) !== hasCoordinates;
    },
    'Provide either ref or both x and y',
  ),
  'browser.type': z.object({ ref: z.string().min(1), text: z.string() }),
  'app.launch': z.object({ application: z.enum(['browser', 'text-editor', 'file-manager']) }),
  'app.openFile': z.object({ path: pathSchema, application: z.enum(['text-editor', 'file-manager']).optional() }),
  'desktop.getState': z.object({}),
  'desktop.listWindows': z.object({}),
  'desktop.focusWindow': z.object({ application: z.string().optional(), titleIncludes: z.string().optional() }),
  'desktop.hotkey': z.object({ keys: z.array(z.string().min(1)).min(1).max(8) }),
  'desktop.type': z.object({ text: z.string() }),
  'desktop.click': coordinateSchema,
  'desktop.screenshot': z.object({}),
} as const;

export function guestProtocolContractJson(): string {
  const methods = Object.entries(guestMethodSchemas)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([method, schema]) => ({ method, params: z.toJSONSchema(schema) }));
  return JSON.stringify({ protocolVersion: GUEST_PROTOCOL_VERSION, methods });
}

export const guestRequestEnvelopeSchema = z.object({
  id: z.string().min(1),
  method: z.string().min(1),
  params: z.unknown(),
});

export const guestResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.string(), message: z.string(), details: z.unknown().optional() })
    .optional(),
});

export function parseGuestRequest(input: unknown) {
  const envelope = guestRequestEnvelopeSchema.parse(input);
  const schema = guestMethodSchemas[envelope.method as keyof typeof guestMethodSchemas];
  if (!schema) {
    throw new Error(`Unknown guest method: ${envelope.method}`);
  }
  return {
    id: envelope.id,
    method: envelope.method as keyof typeof guestMethodSchemas,
    params: schema.parse(envelope.params),
  };
}

export const webSocketEventSchema = z.object({
  type: z.string().min(1),
  timestamp: z.string().datetime(),
  runId: z.string().optional(),
  payload: z.unknown(),
});
