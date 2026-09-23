import type {
  BrowserPageRegion,
  BrowserRegionKind,
  BrowserSearchResult,
} from "./types";

export interface IndexedBrowserRegion extends BrowserPageRegion {
  searchText: string;
  tableHeaders?: string[];
  formLabels?: string[];
  domOrder: number;
  /** Internal DOM ancestry used to suppress overlapping search results. */
  ancestorRefs?: string[];
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

function weightedCoverage(
  queryTokens: readonly string[],
  fieldTokens: ReadonlySet<string>,
  inverseDocumentFrequency: ReadonlyMap<string, number>,
): number {
  if (queryTokens.length === 0) return 0;
  const totalWeight = queryTokens.reduce((sum, token) => sum + (inverseDocumentFrequency.get(token) ?? 1), 0);
  if (totalWeight === 0) return 0;
  const matchedWeight = queryTokens.reduce((sum, token) => (
    sum + (fieldTokens.has(token) ? inverseDocumentFrequency.get(token) ?? 1 : 0)
  ), 0);
  return matchedWeight / totalWeight;
}

function makeIdf(
  regions: readonly IndexedBrowserRegion[],
  queryTokens: readonly string[],
): Map<string, number> {
  const documentFrequency = new Map(queryTokens.map(token => [token, 0]));
  for (const region of regions) {
    const fields = new Set([
      ...tokens(region.searchText),
      ...usefulTokens(region.heading ?? ""),
      ...usefulTokens((region.tableHeaders ?? []).join(" ")),
      ...usefulTokens((region.formLabels ?? []).join(" ")),
    ]);
    for (const token of queryTokens) {
      if (fields.has(token)) documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const count = Math.max(1, regions.length);
  return new Map(queryTokens.map(token => {
    const frequency = documentFrequency.get(token) ?? 0;
    return [token, Math.log((count - frequency + 0.5) / (frequency + 0.5) + 1)];
  }));
}

function scoreWithIdf(
  queryTokens: readonly string[],
  region: IndexedBrowserRegion,
  inverseDocumentFrequency: ReadonlyMap<string, number>,
  averageDocumentLength: number,
): number {
  if (queryTokens.length === 0) return 0;

  const bodyTokens = tokens(region.searchText);
  const bodySet = new Set(bodyTokens);
  const headingTokens = usefulTokens(region.heading ?? "");
  const headingSet = new Set(headingTokens);
  const headerText = (region.tableHeaders ?? []).join(" ");
  const headerSet = new Set(usefulTokens(headerText));
  const formLabelText = (region.formLabels ?? []).join(" ");
  const formLabelSet = new Set(usefulTokens(formLabelText));
  const bodyCoverage = weightedCoverage(queryTokens, bodySet, inverseDocumentFrequency);
  const headingMatch = weightedCoverage(queryTokens, headingSet, inverseDocumentFrequency);
  const headerMatch = weightedCoverage(queryTokens, headerSet, inverseDocumentFrequency);
  const formLabelMatch = weightedCoverage(queryTokens, formLabelSet, inverseDocumentFrequency);
  if (bodyCoverage === 0 && headingMatch === 0 && headerMatch === 0 && formLabelMatch === 0) return 0;

  const frequencies = new Map<string, number>();
  const positions = new Map<string, number>();
  for (let index = 0; index < bodyTokens.length; index += 1) {
    const token = bodyTokens[index]!;
    if (!inverseDocumentFrequency.has(token)) continue;
    frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    if (!positions.has(token)) positions.set(token, index);
  }
  const idfTotal = queryTokens.reduce((sum, token) => sum + (inverseDocumentFrequency.get(token) ?? 0), 0);
  const k1 = 1.2;
  const b = 0.75;
  const lengthRatio = bodyTokens.length / Math.max(1, averageDocumentLength);
  const bm25 = queryTokens.reduce((sum, token) => {
    const frequency = frequencies.get(token) ?? 0;
    if (frequency === 0) return sum;
    const idf = inverseDocumentFrequency.get(token) ?? 0;
    const normalizedFrequency = frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * lengthRatio));
    return sum + idf * normalizedFrequency;
  }, 0);
  const bm25Coverage = idfTotal === 0 ? 0 : clamp(bm25 / (idfTotal * (k1 + 1)), 0, 1);
  const firstHits = queryTokens.flatMap(token => {
    const position = positions.get(token);
    return position === undefined ? [] : [position];
  });
  const spread = firstHits.length < 2 ? 0 : Math.max(...firstHits) - Math.min(...firstHits);
  const proximity = firstHits.length < 2 ? 0.45 : 1 / (1 + spread / (queryTokens.length * 8));
  const normalizedQuery = queryTokens.join(" ");
  const headingPhrase = normalizedQuery.length > 0 && headingTokens.join(" ").includes(normalizedQuery);
  const headerPhrase = normalizedQuery.length > 0 && usefulTokens(headerText).join(" ").includes(normalizedQuery);
  const formLabelPhrase = normalizedQuery.length > 0 && usefulTokens(formLabelText).join(" ").includes(normalizedQuery);

  // The body contributes most of the score. Distinctive terms weigh more
  // through IDF, while headings and especially table headers carry stronger
  // information-density signals than incidental prose.
  const semanticBoost = region.kind === "table"
    ? headerMatch > 0 ? 0.18 + headerMatch * 0.1 : 0
    : region.kind === "form"
      ? formLabelMatch > 0 ? 0.18 + formLabelMatch * 0.08 : 0
      : region.kind === "article"
        ? headingMatch > 0 ? 0.08 : 0
        : region.kind === "section"
          ? headingMatch > 0 ? 0.06 : 0
          : region.kind === "list" && bodyCoverage > 0 ? 0.04 : 0;
  const score = (
    bodyCoverage * 0.3
    + bm25Coverage * 0.12
    + headingMatch * 0.24
    + headerMatch * 0.32
    + formLabelMatch * 0.32
    + proximity * 0.04
    + Number(headingPhrase) * 0.04
    + Number(headerPhrase) * 0.06
    + Number(formLabelPhrase) * 0.08
    + semanticBoost
  );
  return Number(clamp(score, 0, 1).toFixed(3));
}

export function scorePageRegion(query: string, region: IndexedBrowserRegion): number {
  const queryTokens = [...new Set(usefulTokens(query))];
  const idf = makeIdf([region], queryTokens);
  const averageLength = tokens(region.searchText).length;
  return scoreWithIdf(queryTokens, region, idf, averageLength);
}

function matchedQueryTerms(region: IndexedBrowserRegion, queryTokens: readonly string[]): Set<string> {
  const terms = new Set([
    ...tokens(region.searchText),
    ...usefulTokens(region.heading ?? ""),
    ...usefulTokens((region.tableHeaders ?? []).join(" ")),
    ...usefulTokens((region.formLabels ?? []).join(" ")),
  ]);
  return new Set(queryTokens.filter(token => terms.has(token)));
}

function semanticallyMoreSpecific(left: IndexedBrowserRegion, right: IndexedBrowserRegion): boolean {
  const specificity: Record<BrowserRegionKind, number> = {
    table: 7,
    form: 7,
    article: 6,
    list: 5,
    heading: 5,
    section: 4,
    text: 3,
    navigation: 2,
    aside: 2,
    footer: 1,
  };
  return specificity[left.kind] > specificity[right.kind];
}

function nestedDuplicate(
  candidate: IndexedBrowserRegion,
  current: IndexedBrowserRegion,
  candidateTerms: ReadonlySet<string>,
  currentTerms: ReadonlySet<string>,
): boolean {
  const nested = candidate.ancestorRefs?.includes(current.ref) || current.ancestorRefs?.includes(candidate.ref);
  if (!nested || candidateTerms.size === 0 || currentTerms.size === 0) return false;
  const common = [...candidateTerms].filter(token => currentTerms.has(token)).length;
  const overlap = common / Math.min(candidateTerms.size, currentTerms.size);
  return overlap >= 0.8;
}

export function rankPageRegions(input: {
  query: string;
  regions: readonly IndexedBrowserRegion[];
  kinds?: readonly BrowserRegionKind[];
  maxResults?: number;
}): { indexedRegionCount: number; results: BrowserSearchResult[] } {
  const kinds = input.kinds ? new Set(input.kinds) : undefined;
  const maxResults = clamp(Math.trunc(input.maxResults ?? 5), 1, 20);
  const queryTokens = [...new Set(usefulTokens(input.query))];
  const inverseDocumentFrequency = makeIdf(input.regions, queryTokens);
  const averageDocumentLength = input.regions.length === 0 ? 0 : input.regions.reduce(
    (total, region) => total + tokens(region.searchText).length,
    0,
  ) / input.regions.length;
  const ranked = input.regions
    .filter(region => kinds === undefined || kinds.has(region.kind))
    .map(region => ({
      region,
      score: scoreWithIdf(queryTokens, region, inverseDocumentFrequency, averageDocumentLength),
      terms: matchedQueryTerms(region, queryTokens),
    }))
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || left.region.domOrder - right.region.domOrder);
  const selected: typeof ranked = [];
  for (const candidate of ranked) {
    const duplicateIndex = selected.findIndex(current => nestedDuplicate(
      candidate.region,
      current.region,
      candidate.terms,
      current.terms,
    ));
    if (duplicateIndex < 0) {
      selected.push(candidate);
      continue;
    }
    const current = selected[duplicateIndex]!;
    const candidateIsSpecific = semanticallyMoreSpecific(candidate.region, current.region);
    const currentIsSpecific = semanticallyMoreSpecific(current.region, candidate.region);
    if (candidateIsSpecific && candidate.score >= current.score * 0.55) {
      selected.splice(duplicateIndex, 1, candidate);
    } else if (!currentIsSpecific && candidate.score > current.score) {
      selected.splice(duplicateIndex, 1, candidate);
    }
  }
  selected.sort((left, right) => right.score - left.score || left.region.domOrder - right.region.domOrder);
  const results = selected.slice(0, maxResults).map(({ region, score }) => ({
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
  const maxChars = clamp(Math.trunc(input.maxChars), 1, 8_000);
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
  const limit = clamp(Math.trunc(maxChars), 1, 8_000);
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
