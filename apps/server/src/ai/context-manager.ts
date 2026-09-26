import type { ModelMessage } from 'ai';
import { z } from 'zod';

export interface ContextExchange {
  messages: ModelMessage[];
  kind: 'conversation' | 'tool' | 'summary';
  summary?: ContextSummary;
  sourceExchangeCount?: number;
}

export interface ContextSummary {
  goal: string;
  conversationIntent: string[];
  completed: Array<{ description: string; evidenceIds: string[] }>;
  findings: Array<{ statement: string; sourceUrl?: string; evidenceIds: string[] }>;
  artifacts: Array<{ path: string; status: string; evidenceIds: string[] }>;
  environment: {
    browserUrl?: string;
    browserTitle?: string;
    browserRevision?: number;
    focusedWindow?: string;
  };
  unresolved: string[];
  failedApproaches: Array<{ description: string; reason: string }>;
}

export interface ContextBudgetOptions {
  contextWindowTokens: number;
  contextCompactAtRatio: number;
  contextCriticalAtRatio: number;
  contextRecentExchanges: number;
  contextCriticalRecentExchanges: number;
}

export interface ContextUsage {
  estimatedTokens: number;
  contextWindowTokens: number;
  compactions: number;
}

export interface ContextPruningCounts {
  duplicateBrowserObservations: number;
  supersededBrowserObservations: number;
  obsoleteRefs: number;
}

export interface ContextCompactionEvent {
  reason: string;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  contextWindowTokens: number;
  compactions: number;
  oldExchangesCompacted: number;
  recentExchangesKeptRaw: number;
  findingsPreserved: number;
  evidenceIdsPreserved: number;
  pruning: ContextPruningCounts;
  preserved: string[];
  removed: string[];
  summary?: ContextSummary;
}

export const contextSummarySchema = z.object({
  conversationIntent: z.array(z.string().min(1).max(500)).max(16),
  completed: z.array(z.object({
    description: z.string().min(1).max(800),
    evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(16),
  }).strict()).max(24),
  findings: z.array(z.object({
    statement: z.string().min(1).max(1_000),
    sourceUrl: z.string().url().optional(),
    evidenceIds: z.array(z.string().min(1).max(200)).min(1).max(16),
  }).strict()).max(40),
  unresolved: z.array(z.string().min(1).max(800)).max(24),
  failedApproaches: z.array(z.object({
    description: z.string().min(1).max(500),
    reason: z.string().min(1).max(500),
  }).strict()).max(16),
}).strict();

export type ModelContextSummary = z.infer<typeof contextSummarySchema>;

export interface ContextPreparationInput {
  exchanges: ContextExchange[];
  instructions: string;
  currentRequest: string;
  toolDescription: string;
  budget: ContextBudgetOptions;
  compactionCount: number;
  summarize(input: {
    currentRequest: string;
    previousSummary?: ContextSummary;
    messages: ModelMessage[];
    evidenceCatalog: Array<{ id: string; tool: string; sourceUrl?: string }>;
    environment: ContextSummary['environment'];
    signal?: AbortSignal;
  }): Promise<ModelContextSummary>;
  signal?: AbortSignal;
}

export interface ContextPreparationResult {
  exchanges: ContextExchange[];
  usage: ContextUsage;
  compaction?: ContextCompactionEvent;
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable]';
  }
}

function approximateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

export function estimateContextTokens(input: {
  instructions: string;
  toolDescription: string;
  exchanges: readonly ContextExchange[];
}): number {
  const serializedMessages = stringify(input.exchanges.flatMap(exchange => exchange.messages));
  const raw = input.instructions.length + input.toolDescription.length + serializedMessages.length;
  return Math.ceil(raw / 4 * 1.12);
}

export function groupConversation(messages: readonly ModelMessage[], currentRequest: string): ContextExchange[] {
  const exchanges: ContextExchange[] = [];
  let pending: ModelMessage[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    exchanges.push({ messages: pending, kind: 'conversation' });
    pending = [];
  };

  for (const message of messages) {
    if (message.role === 'user' && pending.some(candidate => candidate.role === 'user')) flush();
    pending.push(message);
    if (message.role === 'assistant' && pending.some(candidate => candidate.role === 'user')) flush();
  }
  flush();

  if (!exchanges.some(exchange => exchange.messages.some(message => (
    message.role === 'user' && typeof message.content === 'string' && message.content === currentRequest
  )))) {
    exchanges.push({ messages: [{ role: 'user', content: currentRequest }], kind: 'conversation' });
  }
  return exchanges;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function partsOf(message: ModelMessage): Record<string, unknown>[] {
  const content = (message as unknown as { content?: unknown }).content;
  return Array.isArray(content) ? content.map(record).filter((part): part is Record<string, unknown> => Boolean(part)) : [];
}

function toolOutput(part: Record<string, unknown>): unknown {
  const output = part.output;
  const wrapped = record(output);
  if (wrapped && wrapped.type === 'json' && 'value' in wrapped) return wrapped.value;
  return output;
}

function toolResult(part: Record<string, unknown>): Record<string, unknown> | undefined {
  return record(toolOutput(part));
}

function resultData(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return record(result?.data);
}

function receiptFrom(result: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return record(record(result?.evidence)?.receipt);
}

function pageUrl(tool: string, result: Record<string, unknown> | undefined): string | undefined {
  const data = resultData(result);
  const receipt = receiptFrom(result);
  const effect = record(receipt?.effect);
  const url = data?.url ?? effect?.urlAfter;
  return typeof url === 'string' ? url : undefined;
}

function observations(exchanges: readonly ContextExchange[]): Array<{
  exchange: ContextExchange;
  message: ModelMessage;
  part: Record<string, unknown>;
  tool: string;
  result: Record<string, unknown>;
}> {
  const items: Array<{
    exchange: ContextExchange;
    message: ModelMessage;
    part: Record<string, unknown>;
    tool: string;
    result: Record<string, unknown>;
  }> = [];
  for (const exchange of exchanges) {
    for (const message of exchange.messages) {
      if (message.role !== 'tool') continue;
      for (const part of partsOf(message)) {
        if (part.type !== 'tool-result' || typeof part.toolName !== 'string') continue;
        const result = toolResult(part);
        if (!result) continue;
        items.push({ exchange, message, part, tool: part.toolName, result });
      }
    }
  }
  return items;
}

function browserObservationKey(tool: string, data: Record<string, unknown> | undefined): string | undefined {
  if (!data) return undefined;
  const url = typeof data.url === 'string' ? data.url : '';
  const revision = typeof data.revision === 'number' ? data.revision : '';
  switch (tool) {
    case 'browser.getState':
      return `${tool}|${url}|${data.title ?? ''}|${data.loading ?? ''}|${data.pageCount ?? ''}|${revision}`;
    case 'browser.snapshot':
      return `${tool}|${url}|${revision}`;
    case 'browser.read':
      return `${tool}|${url}|${revision}|${data.mode ?? ''}|${data.ref ?? ''}|${stringify(data.blocks ?? [])}|${stringify(data.sections ?? [])}`;
    case 'browser.search':
      return `${tool}|${url}|${revision}|${data.query ?? ''}|${stringify(data.results ?? [])}`;
    case 'browser.inspectRegion':
      return `${tool}|${url}|${revision}|${data.ref ?? ''}|${stringify(data)}`;
    default:
      return undefined;
  }
}

function replaceToolResult(part: Record<string, unknown>, result: Record<string, unknown>): void {
  const output = part.output;
  const wrapped = record(output);
  if (wrapped && wrapped.type === 'json' && 'value' in wrapped) {
    part.output = { ...wrapped, value: result };
  } else {
    part.output = result;
  }
}

const CONTEXT_TOOL_RESULT_CHARS = 24_000;
const CONTEXT_TOOL_DATA_CHARS = CONTEXT_TOOL_RESULT_CHARS - 4_000;
const CONTEXT_TOOL_STRING_CHARS = 8_000;
const CONTEXT_ARRAY_LIMITS: Readonly<Record<string, number>> = {
  columns: 80,
  elements: 80,
  links: 80,
  outline: 60,
  results: 20,
  rows: 100,
};

function serializedLength(value: unknown): number {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

function boundedString(value: string, state: { remaining: number; truncated: boolean }): string {
  const fullLength = serializedLength(value);
  if (value.length <= CONTEXT_TOOL_STRING_CHARS && fullLength <= state.remaining) {
    state.remaining -= fullLength;
    return value;
  }

  state.truncated = true;
  const marker = '\n...[bounded by context manager]';
  const maxContentLength = Math.min(value.length, CONTEXT_TOOL_STRING_CHARS);
  let low = 0;
  let high = maxContentLength;
  let best = '';
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = `${value.slice(0, middle).trimEnd()}${marker}`;
    if (serializedLength(candidate) <= state.remaining) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (!best) {
    low = 0;
    high = maxContentLength;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = value.slice(0, middle);
      if (serializedLength(candidate) <= state.remaining) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
  }
  state.remaining -= serializedLength(best);
  return best;
}

function boundValue(
  value: unknown,
  state: { remaining: number; truncated: boolean },
  depth = 0,
  key = '',
): unknown {
  if (typeof value === 'string') {
    return boundedString(value, state);
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    const size = serializedLength(value);
    if (size > state.remaining) {
      state.truncated = true;
      return null;
    }
    state.remaining -= size;
    return value;
  }
  if (depth >= 8 || state.remaining <= 0) {
    state.truncated = true;
    return boundedString('[value omitted by context manager]', state);
  }
  if (Array.isArray(value)) {
    const itemLimit = CONTEXT_ARRAY_LIMITS[key] ?? 64;
    const output: unknown[] = [];
    if (state.remaining < 2) {
      state.truncated = true;
      return output;
    }
    state.remaining -= 2;
    for (const item of value.slice(0, itemLimit)) {
      const separatorLength = output.length > 0 ? 1 : 0;
      if (state.remaining <= separatorLength) break;
      state.remaining -= separatorLength;
      output.push(boundValue(item, state, depth + 1));
    }
    if (output.length < value.length) state.truncated = true;
    state.remaining -= 2;
    return output;
  }
  const object = record(value);
  if (!object) return value;
  const priority = [
    'url', 'title', 'query', 'revision', 'ref', 'kind', 'heading', 'format', 'score',
    'truncated', 'columns', 'rowCount', 'returnedRowCount', 'offset', 'columnCount', 'rows',
    'results', 'outline', 'elements', 'text', 'ok', 'error', 'evidence',
  ];
  const priorityIndex = (property: string) => {
    const index = priority.indexOf(property);
    return index < 0 ? priority.length : index;
  };
  const output: Record<string, unknown> = {};
  if (state.remaining < 2) {
    state.truncated = true;
    return output;
  }
  state.remaining -= 2;
  const entries = Object.entries(object).sort((left, right) => priorityIndex(left[0]) - priorityIndex(right[0]));
  for (const [property, child] of entries.slice(0, 80)) {
    const keyLength = serializedLength(property) + 1 + (Object.keys(output).length > 0 ? 1 : 0);
    if (state.remaining <= keyLength) {
      state.truncated = true;
      break;
    }
    state.remaining -= keyLength;
    output[property] = boundValue(child, state, depth + 1, property);
  }
  if (entries.length > 80) state.truncated = true;
  state.remaining -= 2;
  return output;
}

/** Last line of defense for unexpectedly large guest results before model context is built. */
function boundModelToolResults(exchanges: ContextExchange[]): void {
  for (const exchange of exchanges) {
    for (const message of exchange.messages) {
      for (const part of partsOf(message)) {
        if (part.type !== 'tool-result' || typeof part.toolName !== 'string') continue;
        const output = record(part.output);
        if (output && output.type === 'error-json' && 'value' in output) {
          part.output = {
            ...output,
            value: boundValue(output.value, { remaining: 1_500, truncated: false }),
          };
          continue;
        }
        if (output && (output.type === 'text' || output.type === 'error-text') && typeof output.value === 'string') {
          const state = { remaining: CONTEXT_TOOL_DATA_CHARS, truncated: false };
          part.output = { ...output, value: boundedString(output.value, state) };
          continue;
        }
        const result = toolResult(part);
        if (!result) continue;
        const state = {
          remaining: CONTEXT_TOOL_DATA_CHARS,
          truncated: false,
        };
        const bounded: Record<string, unknown> = { ok: result.ok };
        if (result.data !== undefined) {
          const data = boundValue(result.data, state);
          if (state.truncated) {
            const boundedData = record(data);
            if (boundedData) {
              if ('truncated' in boundedData) boundedData.truncated = true;
              if (Array.isArray(boundedData.rows)) boundedData.returnedRowCount = boundedData.rows.length;
              boundedData.contextTruncated = true;
            }
          }
          bounded.data = data;
        }
        if (result.error !== undefined) {
          bounded.error = boundValue(result.error, { remaining: 1_500, truncated: false });
        }
        const receipt = receiptFrom(result);
        if (receipt) bounded.evidence = { receipt: boundValue(receipt, { remaining: 1_500, truncated: false }) };
        replaceToolResult(part, bounded);
      }
    }
  }
}

function latestBrowserState(exchanges: readonly ContextExchange[]): { url: string; revision?: number } | undefined {
  let latest: { url: string; revision?: number } | undefined;
  for (const item of observations(exchanges)) {
    if (!item.tool.startsWith('browser.')) continue;
    const url = pageUrl(item.tool, item.result);
    if (!url) continue;
    const revision = resultData(item.result)?.revision;
    latest = { url, ...(typeof revision === 'number' ? { revision } : {}) };
  }
  return latest;
}

function scrubRefs(value: unknown, currentRevision: number | undefined, keepCurrentRefs: boolean): { value: unknown; removed: number } {
  if (typeof value === 'string') {
    let removed = 0;
    const text = value.replace(/\b([erc])(\d+)-(?:[a-f0-9]{8}-)?\d+\b/gu, (ref, _kind: string, revision: string) => {
      if (keepCurrentRefs && currentRevision !== undefined && Number(revision) === currentRevision) return ref;
      removed += 1;
      return '[expired browser ref]';
    });
    return { value: text, removed };
  }
  if (Array.isArray(value)) {
    let removed = 0;
    const values = value.map(item => {
      const result = scrubRefs(item, currentRevision, keepCurrentRefs);
      removed += result.removed;
      return result.value;
    });
    return { value: values, removed };
  }
  const object = record(value);
  if (!object) return { value, removed: 0 };
  let removed = 0;
  const clean: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(object)) {
    const result = scrubRefs(item, currentRevision, keepCurrentRefs);
    removed += result.removed;
    clean[key] = result.value;
  }
  return { value: clean, removed };
}

function pruneBrowserObservations(exchanges: ContextExchange[]): ContextPruningCounts {
  const counts: ContextPruningCounts = { duplicateBrowserObservations: 0, supersededBrowserObservations: 0, obsoleteRefs: 0 };
  const items = observations(exchanges);
  const currentPage = latestBrowserState(exchanges);
  const latestRevision = new Map<string, number>();
  for (const item of items) {
    if (!item.tool.startsWith('browser.')) continue;
    const data = resultData(item.result);
    const url = pageUrl(item.tool, item.result);
    if (!url || typeof data?.revision !== 'number') continue;
    latestRevision.set(url, Math.max(latestRevision.get(url) ?? -1, data.revision));
  }

  const seen = new Set<string>();
  for (const item of [...items].reverse()) {
    if (!['browser.getState', 'browser.snapshot', 'browser.read', 'browser.search', 'browser.inspectRegion'].includes(item.tool)) continue;
    const data = resultData(item.result);
    if (!data) continue;
    const url = pageUrl(item.tool, item.result);
    const revision = typeof data.revision === 'number' ? data.revision : undefined;
    const currentRevision = url ? latestRevision.get(url) : undefined;
    const obsoleteOutline = (item.tool === 'browser.snapshot' || item.tool === 'browser.search')
      && revision !== undefined && currentRevision !== undefined && revision < currentRevision;
    const key = browserObservationKey(item.tool, data);
    if (data.superseded === true || data.duplicate === true) continue;
    const duplicate = key !== undefined && seen.has(key);
    if (key !== undefined) seen.add(key);
    if (!obsoleteOutline && !duplicate) continue;

    const receipt = receiptFrom(item.result);
    const compactedData = {
      url,
      ...(typeof data.title === 'string' ? { title: data.title } : {}),
      ...(revision === undefined ? {} : { revision }),
      ...(item.tool === 'browser.search' && typeof data.query === 'string' ? { query: data.query } : {}),
      ...(obsoleteOutline ? { superseded: true, note: 'This page revision has newer refs; use the current page state.' } : { duplicate: true, note: 'An equivalent browser observation is already present in newer context.' }),
    };
    replaceToolResult(item.part, {
      ok: item.result.ok,
      data: compactedData,
      ...(receipt ? { evidence: { receipt } } : {}),
    });
    if (obsoleteOutline) counts.supersededBrowserObservations += 1;
    else counts.duplicateBrowserObservations += 1;
    counts.obsoleteRefs += Array.isArray(data.results) ? data.results.length : Array.isArray(data.outline) ? data.outline.length : 0;
  }

  for (const exchange of exchanges) {
    const exchangeBrowserState = latestBrowserState([exchange]);
    const isCurrentRevision = currentPage !== undefined
      && currentPage.revision !== undefined
      && exchangeBrowserState?.url === currentPage.url
      && exchangeBrowserState.revision === currentPage.revision;
    exchange.messages = exchange.messages.map(message => {
      const scrubbed = scrubRefs(message, currentPage?.revision, isCurrentRevision);
      counts.obsoleteRefs += scrubbed.removed;
      return scrubbed.value as ModelMessage;
    });
  }
  return counts;
}

function refIdsIn(value: string): number {
  const refs = value.match(/\b(?:e|r)\d+-\d+\b/gu);
  return refs?.length ?? 0;
}

function removeActionableRefs(value: string): string {
  return value.replace(/\b(?:e|r)\d+-\d+\b/gu, '[expired browser ref]');
}

function deriveOperationalState(exchanges: readonly ContextExchange[]): {
  evidenceCatalog: Array<{ id: string; tool: string; sourceUrl?: string }>;
  environment: ContextSummary['environment'];
  artifacts: ContextSummary['artifacts'];
} {
  const evidenceCatalog: Array<{ id: string; tool: string; sourceUrl?: string }> = [];
  const artifactMap = new Map<string, { path: string; status: string; evidenceIds: string[] }>();
  let environment: ContextSummary['environment'] = {};
  for (const item of observations(exchanges)) {
    const data = resultData(item.result);
    const receipt = receiptFrom(item.result);
    const evidenceId = typeof receipt?.id === 'string' ? receipt.id : undefined;
    const sourceUrl = pageUrl(item.tool, item.result);
    if (evidenceId) evidenceCatalog.push({ id: evidenceId, tool: item.tool, ...(sourceUrl ? { sourceUrl } : {}) });
    if (item.tool.startsWith('browser.') && sourceUrl) {
      const { focusedWindow } = environment;
      environment = {
        ...(focusedWindow ? { focusedWindow } : {}),
        browserUrl: sourceUrl,
        ...(typeof data?.title === 'string' ? { browserTitle: data.title } : {}),
        ...(typeof data?.revision === 'number' ? { browserRevision: data.revision } : {}),
      };
    }
    if (item.tool === 'desktop.getState') {
      const focusedWindow = record(data?.focusedWindow);
      if (typeof focusedWindow?.title === 'string') environment = { ...environment, focusedWindow: focusedWindow.title };
    }
    if (item.result.ok !== true) continue;
    const path = item.tool === 'browser.download'
      ? data?.savedPath
      : item.tool === 'fs.write' || item.tool === 'fs.mkdir' || item.tool === 'app.openFile'
        ? data?.path
        : undefined;
    if (typeof path !== 'string') continue;
    const status = item.tool === 'app.openFile' ? 'opened' : 'created';
    const current = artifactMap.get(path);
    artifactMap.set(path, {
      path,
      status,
      evidenceIds: [...new Set([...(current?.evidenceIds ?? []), ...(evidenceId ? [evidenceId] : [])])],
    });
  }
  for (const exchange of exchanges) {
    if (exchange.kind !== 'summary' || !exchange.summary) continue;
    const summary = exchange.summary;
    environment = {
      ...(environment.browserUrl ? environment : summary.environment),
      ...(environment.focusedWindow || summary.environment.focusedWindow
        ? { focusedWindow: environment.focusedWindow ?? summary.environment.focusedWindow }
        : {}),
    };
    for (const artifact of summary.artifacts) {
      if (!artifactMap.has(artifact.path)) artifactMap.set(artifact.path, artifact);
    }
    const summaryEvidence: Array<{ evidenceIds: string[]; sourceUrl?: string }> = [
      ...summary.completed.map(value => ({ evidenceIds: value.evidenceIds })),
      ...summary.findings.map(value => ({ evidenceIds: value.evidenceIds, sourceUrl: value.sourceUrl })),
      ...summary.artifacts.map(value => ({ evidenceIds: value.evidenceIds })),
    ];
    for (const item of summaryEvidence) {
      for (const id of item.evidenceIds) {
        if (evidenceCatalog.some(existing => existing.id === id)) continue;
        evidenceCatalog.push({ id, tool: 'context.summary.reference', ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}) });
      }
    }
  }
  return { evidenceCatalog, environment, artifacts: [...artifactMap.values()] };
}

function pinnedExchange(exchange: ContextExchange, currentRequest: string): boolean {
  return exchange.kind === 'summary' || exchange.messages.some(message => (
    message.role === 'user' && typeof message.content === 'string' && message.content === currentRequest
  ));
}

function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
  return approximateTokens(stringify(messages));
}

function validatedSummary(input: {
  generated: ModelContextSummary;
  currentRequest: string;
  previous?: ContextSummary;
  evidenceCatalog: Array<{ id: string; tool: string; sourceUrl?: string }>;
  environment: ContextSummary['environment'];
  actualArtifacts: ContextSummary['artifacts'];
}): { summary: ContextSummary; obsoleteRefs: number } {
  const evidenceIds = new Set(input.evidenceCatalog.map(item => item.id));
  const sourceUrls = new Set(input.evidenceCatalog.flatMap(item => item.sourceUrl ? [item.sourceUrl] : []));
  const previousArtifacts = input.previous?.artifacts ?? [];
  const artifactEvidenceIds = new Set([
    ...evidenceIds,
    ...previousArtifacts.flatMap(artifact => artifact.evidenceIds),
    ...input.actualArtifacts.flatMap(artifact => artifact.evidenceIds),
  ]);
  const artifactsByPath = new Map<string, ContextSummary['artifacts'][number]>();
  for (const artifact of [...previousArtifacts, ...input.actualArtifacts]) {
    const ids = artifact.evidenceIds.filter(id => artifactEvidenceIds.has(id));
    artifactsByPath.set(artifact.path, { ...artifact, evidenceIds: ids });
  }
  let obsoleteRefs = 0;
  const clean = (value: string) => {
    obsoleteRefs += refIdsIn(value);
    return removeActionableRefs(value).slice(0, 1_000);
  };
  const summary: ContextSummary = {
    goal: input.currentRequest,
    conversationIntent: input.generated.conversationIntent.map(clean).slice(-16),
    completed: input.generated.completed.flatMap(item => {
      const ids = item.evidenceIds.filter(id => evidenceIds.has(id));
      return ids.length === 0 ? [] : [{ description: clean(item.description), evidenceIds: ids }];
    }).slice(-24),
    findings: input.generated.findings.flatMap(item => {
      const ids = item.evidenceIds.filter(id => evidenceIds.has(id));
      if (ids.length === 0) return [];
      const sourceUrl = item.sourceUrl && sourceUrls.has(item.sourceUrl) ? item.sourceUrl : undefined;
      return [{ statement: clean(item.statement), ...(sourceUrl ? { sourceUrl } : {}), evidenceIds: ids }];
    }).slice(-40),
    artifacts: [...artifactsByPath.values()].slice(-24),
    environment: { ...input.environment },
    unresolved: input.generated.unresolved.map(clean).slice(-24),
    failedApproaches: input.generated.failedApproaches.map(item => ({ description: clean(item.description), reason: clean(item.reason) })).slice(-16),
  };
  return { summary, obsoleteRefs };
}

function summaryMessage(summary: ContextSummary): ModelMessage {
  return {
    role: 'assistant',
    content: `[Helm context summary. This is a lossy continuity note, not source evidence. Verify current state and consult cited evidence before relying on factual claims. Browser refs in older history are expired.]\n${JSON.stringify(summary)}`,
  };
}

export async function prepareModelContext(input: ContextPreparationInput): Promise<ContextPreparationResult> {
  let exchanges = structuredClone(input.exchanges);
  boundModelToolResults(exchanges);
  const beforePruningTokens = estimateContextTokens({
    instructions: input.instructions,
    toolDescription: input.toolDescription,
    exchanges,
  });
  const pruning: ContextPruningCounts = beforePruningTokens / input.budget.contextWindowTokens >= input.budget.contextCompactAtRatio
    ? pruneBrowserObservations(exchanges)
    : { duplicateBrowserObservations: 0, supersededBrowserObservations: 0, obsoleteRefs: 0 };
  const afterPruningTokens = estimateContextTokens({
    instructions: input.instructions,
    toolDescription: input.toolDescription,
    exchanges,
  });
  const ratio = afterPruningTokens / input.budget.contextWindowTokens;
  let compactionCount = input.compactionCount;
  let compaction: ContextCompactionEvent | undefined;
  let oldExchangesCompacted = 0;
  let recentCount = ratio >= input.budget.contextCriticalAtRatio
    ? input.budget.contextCriticalRecentExchanges
    : input.budget.contextRecentExchanges;
  if (ratio >= input.budget.contextCompactAtRatio) {
    const compactedExchanges = new Set<ContextExchange>();
    const originalCount = exchanges.filter(exchange => exchange.kind !== 'summary').length;
    let firstCompactedIndex = -1;
    let summaryState: ContextSummary | undefined;
    let current = afterPruningTokens;

    while (current / input.budget.contextWindowTokens >= Math.max(0.45, input.budget.contextCompactAtRatio - 0.12)) {
      const candidateIndexes = exchanges
        .map((exchange, index) => ({ exchange, index }))
        .filter(({ exchange, index }) => (
          exchange.kind !== 'summary'
          && !pinnedExchange(exchange, input.currentRequest)
          && index < exchanges.length - recentCount
        ));
      if (candidateIndexes.length === 0) {
        if (recentCount > 1) {
          recentCount = 1;
          continue;
        }
        if (current / input.budget.contextWindowTokens < input.budget.contextCriticalAtRatio) break;
        throw new Error(`Context budget exceeded (${current} estimated tokens for a ${input.budget.contextWindowTokens}-token window); no older exchanges can be compacted safely.`);
      }

      const batchLimit = Math.max(1, Math.floor(input.budget.contextWindowTokens * 0.38));
      const batch: typeof candidateIndexes = [];
      let batchTokens = 0;
      for (const candidate of candidateIndexes) {
        const itemTokens = estimateMessagesTokens(candidate.exchange.messages);
        if (batch.length > 0 && batchTokens + itemTokens > batchLimit) break;
        batch.push(candidate);
        batchTokens += itemTokens;
      }
      const earliestIndex = batch[0]!.index;
      if (firstCompactedIndex < 0 || earliestIndex < firstCompactedIndex) firstCompactedIndex = earliestIndex;
      const previous = exchanges.find(exchange => exchange.kind === 'summary')?.summary ?? summaryState;
      const compactableMessages = batch.flatMap(candidate => candidate.exchange.messages);
      const operational = deriveOperationalState(exchanges);
      const summaryBasis: ContextExchange[] = [
        ...(previous ? [{ kind: 'summary' as const, messages: [], summary: previous }] : []),
        ...batch.map(candidate => candidate.exchange),
      ];
      const summarizableEvidence = deriveOperationalState(summaryBasis).evidenceCatalog;
      const generated = await input.summarize({
        currentRequest: input.currentRequest,
        ...(previous ? { previousSummary: previous } : {}),
        messages: compactableMessages,
        evidenceCatalog: summarizableEvidence,
        environment: operational.environment,
        signal: input.signal,
      });
      const normalized = validatedSummary({
        generated,
        currentRequest: input.currentRequest,
        ...(previous ? { previous } : {}),
        evidenceCatalog: summarizableEvidence,
        environment: operational.environment,
        actualArtifacts: operational.artifacts,
      });
      pruning.obsoleteRefs += normalized.obsoleteRefs;
      summaryState = normalized.summary;
      oldExchangesCompacted += batch.length;
      compactionCount += 1;
      for (const item of batch) compactedExchanges.add(item.exchange);
      exchanges = exchanges.filter(exchange => exchange.kind !== 'summary' && !compactedExchanges.has(exchange));
      const insertIndex = Math.max(0, Math.min(firstCompactedIndex, exchanges.length));
      exchanges.splice(insertIndex, 0, {
        messages: [summaryMessage(summaryState)],
        kind: 'summary',
        summary: summaryState,
        sourceExchangeCount: oldExchangesCompacted,
      });
      current = estimateContextTokens({ instructions: input.instructions, toolDescription: input.toolDescription, exchanges });
      if (current / input.budget.contextWindowTokens >= input.budget.contextCriticalAtRatio) recentCount = 1;
      if (oldExchangesCompacted >= originalCount) break;
    }

    if (current / input.budget.contextWindowTokens >= input.budget.contextCriticalAtRatio) {
      throw new Error(`Context budget exceeded (${current} estimated tokens for a ${input.budget.contextWindowTokens}-token window) after safe compaction.`);
    }
  }

  const prunedObservations = pruning.duplicateBrowserObservations
    + pruning.supersededBrowserObservations
    + pruning.obsoleteRefs;
  if (oldExchangesCompacted > 0 || prunedObservations > 0) {
    const operational = deriveOperationalState(exchanges);
    const summary = exchanges.find(exchange => exchange.kind === 'summary')?.summary;
    const preservedEvidenceIds = summary ? new Set([
      ...summary.completed.flatMap(item => item.evidenceIds),
      ...summary.findings.flatMap(item => item.evidenceIds),
      ...summary.artifacts.flatMap(item => item.evidenceIds),
    ]) : new Set<string>();
    compaction = {
      reason: oldExchangesCompacted > 0
        ? `Estimated input reached the configured ${Math.round(input.budget.contextCompactAtRatio * 100)}% context-pressure threshold.`
        : 'Context pressure triggered deterministic pruning of redundant browser observations.',
      estimatedTokensBefore: beforePruningTokens,
      estimatedTokensAfter: estimateContextTokens({ instructions: input.instructions, toolDescription: input.toolDescription, exchanges }),
      contextWindowTokens: input.budget.contextWindowTokens,
      compactions: compactionCount,
      oldExchangesCompacted,
      recentExchangesKeptRaw: Math.min(recentCount, exchanges.filter(exchange => exchange.kind === 'tool' || exchange.kind === 'conversation').length),
      findingsPreserved: summary?.findings.length ?? 0,
      evidenceIdsPreserved: preservedEvidenceIds.size,
      pruning,
      preserved: [
        'Current user request',
        ...(operational.environment.browserUrl ? ['Current browser URL and revision'] : []),
        ...(operational.environment.focusedWindow ? ['Current focused desktop window'] : []),
        ...((summary?.findings.length ?? 0) > 0 ? [`${summary?.findings.length ?? 0} evidence-linked findings`] : []),
        ...((summary?.completed.length ?? 0) > 0 ? [`${summary?.completed.length ?? 0} evidence-backed completed actions`] : []),
        ...(operational.artifacts.length > 0 ? [`${operational.artifacts.length} observed artifacts`] : []),
      ],
      removed: [
        ...(pruning.duplicateBrowserObservations > 0 ? [`${pruning.duplicateBrowserObservations} duplicate browser observations`] : []),
        ...(pruning.supersededBrowserObservations > 0 ? [`${pruning.supersededBrowserObservations} superseded browser observations`] : []),
        ...(oldExchangesCompacted > 0 ? [`${oldExchangesCompacted} older exchanges replaced by a structured summary`] : []),
        ...(pruning.obsoleteRefs > 0 ? [`${pruning.obsoleteRefs} obsolete browser refs`] : []),
      ],
      ...(summary ? { summary } : {}),
    };
  }

  const estimatedTokens = estimateContextTokens({ instructions: input.instructions, toolDescription: input.toolDescription, exchanges });
  return {
    exchanges,
    usage: {
      estimatedTokens,
      contextWindowTokens: input.budget.contextWindowTokens,
      compactions: compactionCount,
    },
    ...(compaction ? { compaction } : {}),
  };
}
