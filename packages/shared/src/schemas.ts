import { z } from 'zod';
import { normalizeBrowserUrl } from './browser-url';

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
export const guestMethodSchemas = {
  'guest.handshake': z.object({}),
  'fs.read': z.object({ path: pathSchema }),
  'fs.write': z.object({
    path: pathSchema,
    content: z.string().max(50 * 1024 * 1024).optional(),
    sourceRef: z.string().regex(/^c\d+-[a-f0-9]{8}-[1-9]\d*$/u).optional(),
    format: z.enum(['text', 'markdown', 'json', 'csv']).optional(),
  }).refine(
    value => (value.content !== undefined) !== (value.sourceRef !== undefined),
    'Provide exactly one of content or sourceRef',
  ).refine(
    value => value.format === undefined || value.sourceRef !== undefined,
    'format is only supported when writing from sourceRef',
  ),
  'fs.mkdir': z.object({ path: pathSchema }),
  'fs.exists': z.object({ path: pathSchema }),
  'fs.list': z.object({ path: pathSchema }),
  'fs.stat': z.object({ path: pathSchema }),
  'browser.navigate': z.object({ url: z.string().min(1) }),
  'browser.getState': z.object({}),
  'browser.snapshot': z.object({ maxRegions: z.number().int().min(1).max(100).optional() }),
  'browser.read': z.object({
    mode: z.enum(['readable', 'document']).optional(),
    query: z.string().trim().min(1).max(1_000).optional(),
    ref: z.string().regex(/^c\d+-[a-f0-9]{8}-[1-9]\d*$/u).optional(),
    maxChars: z.number().int().min(1).max(12_000).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }).strict(),
  'browser.search': z.object({
    query: z.string().trim().min(1).max(1_000),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  'browser.open': z.object({
    ref: z.string().regex(/^c\d+-[a-f0-9]{8}-[1-9]\d*$/u),
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
