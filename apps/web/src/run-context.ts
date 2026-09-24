export interface ContextUsageIndicator {
  estimatedTokens: number;
  contextWindowTokens: number;
  compactions: number;
}

export interface ContextCompactionDisplay {
  reason: string;
  estimatedInput: string;
  exchanges: string;
  preserved: string[];
  removed: string[];
  findings: Array<{ statement: string; evidenceIds: string[] }>;
}

export interface BrowserSearchDisplay {
  query: string;
  coverage: string;
  matches: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function tokenLabel(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(Math.trunc(value));
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export function contextUsageFromEvent(
  eventType: string,
  payloadValue: unknown,
  previous?: ContextUsageIndicator,
): ContextUsageIndicator | undefined {
  const payload = record(payloadValue);
  const estimatedTokens = eventType === 'run.context.compacted'
    ? payload?.estimatedTokensAfter
    : payload?.estimatedTokens;
  if (typeof estimatedTokens !== 'number' || typeof payload?.contextWindowTokens !== 'number') return previous;
  return {
    estimatedTokens,
    contextWindowTokens: payload.contextWindowTokens,
    compactions: typeof payload.compactions === 'number' ? payload.compactions : previous?.compactions ?? 0,
  };
}

export function contextUsageLabel(usage: ContextUsageIndicator): string {
  const estimatedTokens = tokenLabel(usage.estimatedTokens) ?? '?';
  const contextWindowTokens = tokenLabel(usage.contextWindowTokens) ?? '?';
  return `Estimated context ${estimatedTokens} / ${contextWindowTokens}${usage.compactions > 0 ? ` · Compacted ${usage.compactions}×` : ''}`;
}

export function contextCompactionDisplay(value: unknown): ContextCompactionDisplay | undefined {
  const compaction = record(value);
  if (!compaction) return undefined;
  const summary = record(compaction.summary);
  const findings = Array.isArray(summary?.findings)
    ? summary.findings.flatMap(value => {
      const finding = record(value);
      if (typeof finding?.statement !== 'string') return [];
      return [{ statement: finding.statement, evidenceIds: stringList(finding.evidenceIds) }];
    })
    : [];
  const before = tokenLabel(compaction.estimatedTokensBefore) ?? '?';
  const after = tokenLabel(compaction.estimatedTokensAfter) ?? '?';
  const window = tokenLabel(compaction.contextWindowTokens) ?? '?';
  const compacted = typeof compaction.oldExchangesCompacted === 'number' ? compaction.oldExchangesCompacted : 0;
  const recent = typeof compaction.recentExchangesKeptRaw === 'number' ? compaction.recentExchangesKeptRaw : 0;
  return {
    reason: typeof compaction.reason === 'string' ? compaction.reason : 'Context pressure',
    estimatedInput: `${before} → ${after} / ${window} tokens`,
    exchanges: `${compacted} older compacted · ${recent} kept raw`,
    preserved: stringList(compaction.preserved),
    removed: stringList(compaction.removed),
    findings,
  };
}

export function browserSearchDisplay(value: unknown, queryValue: unknown): BrowserSearchDisplay {
  const data = record(value);
  const results = Array.isArray(data?.results) ? data.results.flatMap(item => {
    const match = record(item);
    if (!match) return [];
    return [[
      typeof match.ref === 'string' ? match.ref : 'region',
      typeof match.kind === 'string' ? match.kind : 'unknown',
      typeof match.heading === 'string' ? match.heading : '',
      typeof match.score === 'number' ? match.score.toFixed(2) : '',
      typeof match.snippet === 'string' ? match.snippet : typeof match.preview === 'string' ? match.preview : '',
    ].filter(Boolean).join(' · ')];
  }) : [];
  const count = typeof data?.matchCount === 'number' ? data.matchCount : results.length;
  const readability = data?.pageReadable === true
    ? 'readable page content found'
    : data?.pageReadable === false
      ? 'no readable page content found'
      : undefined;
  return {
    query: typeof queryValue === 'string' ? queryValue : 'Page search',
    coverage: `${typeof data?.indexedRegionCount === 'number' ? data.indexedRegionCount : 0} regions indexed · ${count} match${count === 1 ? '' : 'es'}${readability ? ` · ${readability}` : ''}`,
    matches: results.join('\n'),
  };
}

export function browserInspectionSummary(value: unknown): string | undefined {
  const inspection = record(value);
  if (!inspection) return undefined;
  if (inspection.format === 'table') {
    return `${typeof inspection.heading === 'string' ? `${inspection.heading}: ` : ''}Table, ${String(inspection.rowCount ?? 0)} rows × ${String(inspection.columnCount ?? 0)} columns`;
  }
  return `${typeof inspection.heading === 'string' ? inspection.heading : 'Page region'} · ${String(inspection.kind ?? 'text')}`;
}
