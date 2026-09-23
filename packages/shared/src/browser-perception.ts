import type {
  BrowserPageRegion,
  BrowserRegionKind,
  BrowserSearchResult,
} from "./types";

export interface IndexedBrowserRegion extends BrowserPageRegion {
  searchText: string;
  tableHeaders?: string[];
  domOrder: number;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "is", "it",
  "of", "on", "or", "that", "the", "this", "to", "was", "were", "with",
]);

function tokens(value: string): string[] {
  return value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function usefulTokens(value: string): string[] {
  const all = tokens(value);
  const useful = all.filter(token => token.length > 1 && !STOP_WORDS.has(token));
  return useful.length > 0 ? useful : all;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function overlapRatio(needles: readonly string[], haystack: ReadonlySet<string>): number {
  if (needles.length === 0) return 0;
  return needles.reduce((count, token) => count + Number(haystack.has(token)), 0) / needles.length;
}

export function scorePageRegion(query: string, region: IndexedBrowserRegion): number {
  const queryTokens = [...new Set(usefulTokens(query))];
  if (queryTokens.length === 0) return 0;

  const bodyTokens = tokens(region.searchText);
  const bodySet = new Set(bodyTokens);
  const querySet = new Set(queryTokens);
  const headingTokens = usefulTokens(region.heading ?? "");
  const headingSet = new Set(headingTokens);
  const headerText = (region.tableHeaders ?? []).join(" ");
  const headerTokens = usefulTokens(headerText);
  const headerSet = new Set(headerTokens);
  const coverage = overlapRatio(queryTokens, bodySet);
  const headingMatch = overlapRatio(queryTokens, headingSet);
  const headerMatch = overlapRatio(queryTokens, headerSet);
  if (coverage === 0 && headingMatch === 0 && headerMatch === 0) return 0;

  const positions = new Map<string, number[]>();
  const frequencies = new Map<string, number>();
  for (let index = 0; index < bodyTokens.length; index += 1) {
    const token = bodyTokens[index]!;
    if (!querySet.has(token)) continue;
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    const found = positions.get(token) ?? [];
    if (found.length < 8) found.push(index);
    positions.set(token, found);
  }
  const firstHits = queryTokens.flatMap(token => positions.get(token)?.slice(0, 1) ?? []);
  const spread = firstHits.length < 2 ? 0 : Math.max(...firstHits) - Math.min(...firstHits);
  const proximity = firstHits.length < 2 ? 0.5 : 1 / (1 + spread / (queryTokens.length * 8));
  const normalizedQuery = usefulTokens(query).join(" ");
  const headingPhrase = usefulTokens(region.heading ?? "").join(" ").includes(normalizedQuery);
  const headerPhrase = usefulTokens(headerText).join(" ").includes(normalizedQuery);
  const termFrequency = queryTokens.reduce((sum, token) => {
    return sum + Math.min(1, Math.log1p(frequencies.get(token) ?? 0) / 3);
  }, 0) / queryTokens.length;
  const tableHeaderBoost = region.kind === "table" && headerMatch >= 0.5 ? 0.08 : 0;
  const score = (
    coverage * 0.42
    + headingMatch * 0.18
    + headerMatch * 0.16
    + proximity * 0.08
    + termFrequency * 0.08
    + Number(headingPhrase) * 0.04
    + Number(headerPhrase) * 0.04
    + tableHeaderBoost
  );
  return Number(clamp(score, 0, 1).toFixed(3));
}

export function rankPageRegions(input: {
  query: string;
  regions: readonly IndexedBrowserRegion[];
  kinds?: readonly BrowserRegionKind[];
  maxResults?: number;
}): { indexedRegionCount: number; results: BrowserSearchResult[] } {
  const kinds = input.kinds ? new Set(input.kinds) : undefined;
  const maxResults = clamp(Math.trunc(input.maxResults ?? 8), 1, 20);
  const results = input.regions
    .filter(region => kinds === undefined || kinds.has(region.kind))
    .map(region => ({ region, score: scorePageRegion(input.query, region) }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.region.domOrder - right.region.domOrder)
    .slice(0, maxResults)
    .map(({ region, score }) => ({
      ref: region.ref,
      kind: region.kind,
      ...(region.heading ? { heading: region.heading } : {}),
      ...(region.preview ? { preview: region.preview } : {}),
      ...(region.rowCount === undefined ? {} : { rowCount: region.rowCount }),
      ...(region.columnCount === undefined ? {} : { columnCount: region.columnCount }),
      score,
    }));
  return { indexedRegionCount: input.regions.length, results };
}

interface Passage {
  text: string;
  order: number;
  score: number;
}

function passagePieces(text: string, query: string): Passage[] {
  const rawParagraphs = text.replace(/\r\n?/gu, "\n").split(/\n{2,}/u);
  const paragraphs = rawParagraphs.flatMap(paragraph => {
    const cleaned = paragraph.replace(/\s+/gu, " ").trim();
    if (cleaned.length <= 1_200) return cleaned ? [cleaned] : [];
    const sentences = cleaned.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.map(value => value.trim()).filter(Boolean) ?? [];
    if (sentences.length > 1) return sentences;
    const queryTokens = [...new Set(usefulTokens(query))];
    const windows: string[] = [];
    for (const token of queryTokens) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      const matcher = new RegExp(escaped, "giu");
      let match: RegExpExecArray | null;
      while ((match = matcher.exec(cleaned)) !== null && windows.length < 24) {
        const start = Math.max(0, match.index - 480);
        const end = Math.min(cleaned.length, match.index + token.length + 720);
        windows.push(`${start > 0 ? "…" : ""}${cleaned.slice(start, end)}${end < cleaned.length ? "…" : ""}`);
        if (match[0].length === 0) matcher.lastIndex += 1;
      }
    }
    return windows.length > 0 ? windows : [cleaned.slice(0, 1_200)];
  });

  return paragraphs.map((value, order) => ({
    text: value,
    order,
    score: scorePageRegion(query, {
      ref: `r${order + 1}`,
      kind: "text",
      searchText: value,
      domOrder: order,
    }),
  }));
}

export function extractRelevantPassages(input: {
  text: string;
  query: string;
  maxChars: number;
  maxResults?: number;
}): { text: string; matches: number; truncated: boolean } {
  const maxChars = clamp(Math.trunc(input.maxChars), 1, 100_000);
  const maxResults = clamp(Math.trunc(input.maxResults ?? 8), 1, 20);
  const ranked = passagePieces(input.text, input.query)
    .filter(passage => passage.score > 0)
    .sort((left, right) => right.score - left.score || left.order - right.order);
  const selected: Passage[] = [];
  let chars = 0;
  let truncated = false;
  for (const passage of ranked) {
    if (selected.length >= maxResults) break;
    const separatorChars = selected.length === 0 ? 0 : 2;
    const available = maxChars - chars - separatorChars;
    if (available <= 0) {
      truncated = true;
      break;
    }
    const value = passage.text.length > available ? passage.text.slice(0, available) : passage.text;
    selected.push({ ...passage, text: value });
    chars += separatorChars + value.length;
    if (value.length < passage.text.length) {
      truncated = true;
      break;
    }
  }
  return {
    text: selected.map(passage => passage.text).join("\n\n"),
    matches: ranked.length,
    truncated: truncated || ranked.length > selected.length,
  };
}

export function sampleReadableText(text: string, maxChars: number): { text: string; truncated: boolean } {
  const limit = clamp(Math.trunc(maxChars), 1, 100_000);
  const normalized = text.replace(/\r\n?/gu, "\n").trim();
  if (normalized.length <= limit) return { text: normalized, truncated: false };
  if (limit <= 3) return { text: normalized.slice(0, limit), truncated: true };
  const paragraphs = normalized.split(/\n+/u).map(value => value.trim()).filter(Boolean);
  if (paragraphs.length <= 1) {
    const contentBudget = limit - 3;
    const headSize = Math.ceil(contentBudget * 0.6);
    const tailSize = contentBudget - headSize;
    const tail = tailSize > 0 ? normalized.slice(-tailSize) : "";
    return {
      text: `${normalized.slice(0, headSize)}\n…\n${tail}`,
      truncated: true,
    };
  }

  const separator = "\n…\n";
  const contentBudget = limit - separator.length;
  const headSize = Math.floor(contentBudget * 0.6);
  const tailSize = contentBudget - headSize;
  const joined = paragraphs.join("\n");
  const head = joined.slice(0, headSize);
  const tail = tailSize > 0 ? joined.slice(-tailSize) : "";
  return { text: `${head}${separator}${tail}`, truncated: true };
}

export function boundedPagePreview(value: string, maxChars: number): string | undefined {
  const clean = value.replace(/\s+/gu, " ").trim();
  if (!clean) return undefined;
  return clean.length <= maxChars ? clean : `${clean.slice(0, maxChars - 1)}…`;
}
