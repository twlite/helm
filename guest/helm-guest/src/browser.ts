import { GuestRpcError } from "./errors";
import type { GuestSandbox } from "./sandbox";
import { normalizeBrowserUrl } from "../../../packages/shared/src/browser-url";
import { deriveBrowserReadQuery, rankBrowserContentBlocks } from "../../../packages/shared/src/browser-perception";
import type {
  BrowserContentBlock,
  BrowserContentFormat,
  BrowserContentSummary,
  BrowserOpenResult,
  BrowserPageType,
  BrowserPageRegion,
  BrowserReadMode,
  BrowserReadResult,
  BrowserRegionInspection,
  BrowserRegionKind,
  BrowserSearchPageResult,
  BrowserSnapshot as SharedBrowserSnapshot,
} from "../../../packages/shared/src/types";
import { Readability } from "@mozilla/readability";
import { extractAccessibleCandidate, extractSemanticBrowserBlocks } from "./semantic-extraction";

type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

interface PlaywrightLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(value: string, options?: { timeout?: number }): Promise<void>;
  nth(index: number): PlaywrightLocator;
  evaluateAll<T>(
    pageFunction: (elements: readonly unknown[], arg?: unknown) => T,
    arg?: unknown,
  ): Promise<T>;
  ariaSnapshotJSON?(options?: { mode?: "ai" | "default"; depth?: number }): Promise<unknown>;
  getAttribute(name: string): Promise<string | null>;
}

interface PlaywrightElementHandle {
  evaluate<T>(pageFunction: (element: unknown) => T): Promise<T>;
}

interface PlaywrightDownload {
  url(): string;
  suggestedFilename(): string;
  saveAs(path: string): Promise<void>;
}

interface PlaywrightPage {
  goto(
    url: string,
    options?: { waitUntil?: WaitUntil; timeout?: number },
  ): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  locator(selector: string): PlaywrightLocator;
  frames(): PlaywrightFrame[];
  addScriptTag(options: { content: string }): Promise<PlaywrightElementHandle>;
  mouse: { click(x: number, y: number): Promise<void> };
  waitForEvent(event: "download", options?: { timeout?: number }): Promise<PlaywrightDownload>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  waitForLoadState(state?: WaitUntil, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  isClosed?(): boolean;
}

interface PlaywrightFrame {
  url(): string;
  name(): string;
  locator(selector: string): PlaywrightLocator;
  addScriptTag(options: { content: string }): Promise<PlaywrightElementHandle>;
}

interface PlaywrightContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(
    userDataDir: string,
    options: {
      headless: boolean;
      viewport: null;
      executablePath?: string;
      args?: readonly string[];
    },
  ): Promise<PlaywrightContext>;
}

interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

interface SemanticElement {
  index: number;
  role: string;
  name: string;
  value?: string;
  text?: string;
  enabled: boolean;
  href?: string;
  checked?: boolean;
  selected?: boolean;
}

interface PageRegionRecord extends BrowserPageRegion {
  domOrder: number;
  candidateIndex: number;
}

interface BrowserReference {
  locator: PlaywrightLocator;
  revision: number;
  url: string;
  kind: "element" | "region";
  regionKind?: BrowserRegionKind;
  heading?: string;
}

export interface BrowserState {
  ready: boolean;
  visible: true;
  url: string;
  title: string;
  loading: boolean;
  pageCount: number;
  revision: number;
}

export type BrowserSnapshot = SharedBrowserSnapshot;

const INTERACTIVE_SELECTOR =
  "button, input, textarea, select, a[href], summary, [role], [contenteditable='true']";
const REGION_SELECTOR = [
  "main", "article", "section", "table", "ul", "ol", "form", "nav", "aside", "footer",
  "h1", "h2", "h3", "h4", "h5", "h6", "[role='main']", "[role='article']", "[role='region']", "[role='heading']", "[role='table']",
  "[role='navigation']", "[role='contentinfo']", "[role='complementary']", "[role='list']", "[role='form']",
  "p", "blockquote", "pre", "dl", "div",
].join(", ");
const MAX_INDEXED_REGIONS = 1_200;
const DEFAULT_OUTLINE_REGIONS = 60;
const MAX_INTERACTIVE_ELEMENTS = 80;
const DEFAULT_READ_CHARS = 4_000;
const DEFAULT_BLOCK_PREVIEW_CHARS = 520;
const DEFAULT_REGION_CHARS = 8_000;
const DEFAULT_TABLE_ROWS = 50;
const BROWSER_OPERATION_TIMEOUT_MS = 10_000;
const BROWSER_CONTEXT_RESET_TIMEOUT_MS = 1_000;

interface IndexedSemanticContent {
  blocks: BrowserContentBlock[];
  pageType: BrowserPageType;
  sourceTruncated: boolean;
  extractors: string[];
  inaccessibleFrames: number;
}

interface SerializableContentReference {
  block: BrowserContentBlock;
  revision: number;
  url: string;
}

function createContentSessionId(): string {
  return crypto.randomUUID().replace(/-/gu, '').slice(0, 8);
}

class BrowserOperationTimeout extends Error {
  constructor(public readonly operation: string) {
    super(`${operation} timed out.`);
    this.name = "BrowserOperationTimeout";
  }
}

let playwrightModule: Promise<PlaywrightModule> | undefined;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (playwrightModule !== undefined) return playwrightModule;

  playwrightModule = (async () => {
    try {
      // Playwright is an optional runtime dependency in development. It is
      // intentionally kept external because the browser binary is provisioned
      // in the guest image, while this server bundle is injected separately.
      const imported = await import("playwright");
      const module = imported as unknown as PlaywrightModule;
      if (module.chromium === undefined) {
        throw new Error("Playwright chromium export is unavailable.");
      }
      return module;
    } catch {
      throw new GuestRpcError(
        "PLAYWRIGHT_UNAVAILABLE",
        "Playwright is not installed in the guest runtime.",
      );
    }
  })();

  return playwrightModule;
}

function safeUrl(value: string): string {
  try {
    return normalizeBrowserUrl(value);
  } catch (error) {
    throw new GuestRpcError("INVALID_PARAMS", error instanceof Error ? error.message : "url must be a valid http, https, file, or about URL.", {
      httpStatus: 400,
    });
  }
}

function browserLaunchError(error: unknown): GuestRpcError {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : "Visible Chromium could not be started.";
  if (/Executable doesn't exist at|playwright install/iu.test(message)) {
    return new GuestRpcError(
      "PLAYWRIGHT_BROWSER_MISSING",
      "Playwright Chromium is not installed in the guest. As the helm user, run `npx playwright install --with-deps chromium` (or `bunx --bun playwright install --with-deps chromium`), then restart helm-guest.",
      {
        details: {
          installCommand: "npx playwright install --with-deps chromium",
          originalMessage: message,
        },
      },
    );
  }
  return new GuestRpcError("BROWSER_START_FAILED", message);
}

function isClosedBrowserError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:target page|page|browser|context).*(?:closed|crashed)|(?:browser|context|connection) has been closed|target closed/iu.test(
    message,
  );
}

function readabilityInjectionSource(): string {
  const valueSource = (value: unknown): string => {
    if (typeof value === "function") return value.toString();
    if (value instanceof RegExp) return `new RegExp(${JSON.stringify(value.source)}, ${JSON.stringify(value.flags)})`;
    if (Array.isArray(value)) return `[${value.map(valueSource).join(", ")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.entries(value).map(([key, nested]) => `${JSON.stringify(key)}: ${valueSource(nested)}`).join(", ")}}`;
    }
    if (value === undefined) return "undefined";
    return JSON.stringify(value) ?? "null";
  };
  const members = Object.entries(Object.getOwnPropertyDescriptors(Readability.prototype))
    .filter(([name, descriptor]) => name !== "constructor" && "value" in descriptor)
    .map(([name, descriptor]) => typeof descriptor.value === "function"
      ? descriptor.value.toString()
      : `${JSON.stringify(name)}: ${valueSource(descriptor.value)}`)
    .join(",\n");
  return `(() => {\nconst Readability = ${Readability.toString()};\nReadability.prototype = {\n${members}\n};\nwindow.__helmReadability = Readability;\n})();`;
}

function tableCsvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}

function blockText(block: BrowserContentBlock): string {
  if (block.type === "table") {
    const heading = block.headingPath?.join(" / ") || block.heading || block.caption;
    return [
      heading,
      block.columns?.join(" | "),
      ...(block.rows ?? []).map(row => row.join(" | ")),
    ].filter(Boolean).join("\n");
  }
  if (block.type === "list") return (block.items ?? []).map((item, index) => (
    block.ordered ? `${index + 1}. ${item}` : `- ${item}`
  )).join("\n");
  if (block.type === "definition") return (block.definitions ?? [])
    .map(item => `${item.term}: ${item.definition}`).join("\n");
  if (block.type === "form") return (block.fields ?? [])
    .map(field => `${field.label || field.type || "Field"}${field.required ? " (required)" : ""}${field.value ? `: ${field.value}` : ""}`).join("\n");
  if (block.type === "search_result") {
    return [block.title, block.href, block.snippet].filter(Boolean).join("\n");
  }
  if (block.type === "navigation") {
    const links = (block.links ?? []).map(link => `${link.text || link.href}${link.text ? ` (${link.href})` : ""}`);
    return [block.text, ...links].filter(Boolean).join("\n");
  }
  return block.text ?? "";
}

function serializeBrowserContentBlock(block: BrowserContentBlock, format: BrowserContentFormat): string {
  if (format === "json") return `${JSON.stringify({
    type: block.type,
    heading: block.heading,
    headingPath: block.headingPath,
    ...(block.caption ? { caption: block.caption } : {}),
    ...(block.columns ? { columns: block.columns } : {}),
    ...(block.rows ? { rows: block.rows } : {}),
    ...(block.items ? { items: block.items } : {}),
    ...(block.fields ? { fields: block.fields } : {}),
    ...(block.definitions ? { definitions: block.definitions } : {}),
    ...(block.links ? { links: block.links } : {}),
    ...(block.title ? { title: block.title } : {}),
    ...(block.href ? { href: block.href } : {}),
    ...(block.snippet ? { snippet: block.snippet } : {}),
    ...(block.language ? { language: block.language } : {}),
    ...(block.text ? { text: block.text } : {}),
    ...(block.cellSpans ? { cellSpans: block.cellSpans } : {}),
  }, null, 2)}\n`;
  if (format === "csv") {
    if (block.type !== "table" || !block.columns || !block.rows) {
      throw new GuestRpcError("UNSUPPORTED_CONTENT_FORMAT", "CSV export requires a table content ref.", { httpStatus: 400 });
    }
    return [
      block.columns.map(tableCsvCell).join(","),
      ...block.rows.map(row => block.columns!.map((_, index) => tableCsvCell(row[index] ?? "")).join(",")),
    ].join("\n") + "\n";
  }
  if (format === "markdown" && block.type === "table" && block.columns && block.rows) {
    const heading = block.headingPath?.join(" / ") || block.heading || block.caption;
    const escape = (value: string): string => value.replace(/\\/gu, "\\\\").replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
    return [
      ...(heading ? [`## ${heading}`, ""] : []),
      `| ${block.columns.map(escape).join(" | ")} |`,
      `| ${block.columns.map(() => "---").join(" | ")} |`,
      ...block.rows.map(row => `| ${block.columns!.map((_, index) => escape(row[index] ?? "")).join(" | ")} |`),
    ].join("\n") + "\n";
  }
  if (format === "markdown") {
    const heading = block.headingPath?.join(" / ") || block.heading;
    const text = blockText(block);
    return `${heading ? `## ${heading}\n\n` : ""}${text}\n`;
  }
  const heading = block.type === "heading" ? undefined : block.headingPath?.join(" / ") || block.heading;
  return `${heading ? `${heading}\n\n` : ""}${blockText(block)}\n`;
}

export class BrowserController {
  private readonly contentSessionId = createContentSessionId();
  private context: PlaywrightContext | undefined;
  private page: PlaywrightPage | undefined;
  private loading = false;
  private referenceRevision = 0;
  private referenceUrl = "";
  private lastDomMutationCount: number | undefined;
  private lastFrameMutationSignature: string | undefined;
  private references = new Map<string, BrowserReference>();
  private contentReferences = new Map<string, SerializableContentReference>();
  private readabilitySource = readabilityInjectionSource();
  private outlineCache: { revision: number; records: PageRegionRecord[]; regionCount: number; truncated: boolean } | undefined;

  constructor(
    private readonly sandbox: GuestSandbox,
    private readonly options: {
      profilePath?: string;
      executablePath?: string;
      extraArgs?: readonly string[];
      /** Headless mode is used by local browser-perception integration tests. */
      headless?: boolean;
    } = {},
  ) {}

  async start(): Promise<BrowserState> {
    await this.ensurePage();
    return this.getState();
  }

  async navigate(input: {
    url: string;
    waitUntil?: WaitUntil;
    timeoutMs?: number;
  }): Promise<BrowserState> {
    const url = safeUrl(input.url);
    const page = await this.ensurePage();
    const waitUntil = input.waitUntil ?? "domcontentloaded";
    const timeoutMs = input.timeoutMs ?? 30_000;
    this.invalidateReferences();
    this.loading = true;

    try {
      return await this.navigatePage(page, url, waitUntil, timeoutMs);
    } catch (error) {
      // Chromium can be closed from the guest desktop while the controller
      // still holds the old Playwright page object. Recreate the persistent
      // context once so the next agent action can recover instead of
      // repeating the same stale-page failure until the runtime loop guard
      // stops the task.
      if (isClosedBrowserError(error)) {
        await this.resetContext();
        try {
          const reopenedPage = await this.ensurePage();
          return await this.navigatePage(reopenedPage, url, waitUntil, timeoutMs);
        } catch (retryError) {
          throw new GuestRpcError(
            "BROWSER_NAVIGATION_FAILED",
            retryError instanceof Error ? retryError.message.slice(0, 500) : "The page could not be loaded.",
            { details: await this.stateWithoutThrowing(this.page ?? page) },
          );
        }
      }
      throw new GuestRpcError(
        "BROWSER_NAVIGATION_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The page could not be loaded.",
        { details: await this.stateWithoutThrowing(page) },
      );
    } finally {
      this.loading = false;
    }
  }

  async getState(): Promise<BrowserState> {
    return this.withWatchdog(() => this.getStateInternal(), "browser.getState");
  }

  private async getStateInternal(): Promise<BrowserState> {
    const page = await this.ensurePage();
    await this.refreshDomRevision(page);
    return {
      ready: true,
      visible: true,
      url: page.url(),
      title: await this.readTitle(page),
      loading: this.loading,
      pageCount: this.context?.pages().length ?? 1,
      revision: this.referenceRevision,
    };
  }

  async snapshot(input: { maxRegions?: number } = {}): Promise<BrowserSnapshot> {
    return this.withWatchdog(() => this.snapshotInternal(input), "browser.snapshot");
  }

  private async snapshotInternal(input: { maxRegions?: number }, attempt = 0): Promise<BrowserSnapshot> {
    const page = await this.ensurePage();
    const url = page.url();
    const title = await this.readTitle(page);
    const candidates = page.locator(INTERACTIVE_SELECTOR);
    await this.refreshDomRevision(page);
    const revision = this.referenceRevision;
    const regionIndex = await this.getRegionRecords(page);
    const prioritized = [...regionIndex.records]
      .sort((left, right) => outlinePriority(left.kind) - outlinePriority(right.kind) || left.domOrder - right.domOrder);
    const maxRegions = Math.max(1, Math.min(100, Math.trunc(input.maxRegions ?? DEFAULT_OUTLINE_REGIONS)));
    const outline = prioritized.slice(0, maxRegions).sort((left, right) => left.domOrder - right.domOrder);
    let elements: SemanticElement[];
    try {
      elements = await candidates.evaluateAll((nodes, limit) =>
        nodes.flatMap((node, index) => {
          if (!(node instanceof HTMLElement)) return [];
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            rect.width === 0 ||
            rect.height === 0
          ) {
            return [];
          }

          const explicitRole = node.getAttribute("role")?.trim();
          const tag = node.tagName.toLowerCase();
          const inputType =
            node instanceof HTMLInputElement ? node.type.toLowerCase() : undefined;
          const role =
            explicitRole ??
            (tag === "a"
              ? "link"
              : tag === "button"
                ? "button"
                : tag === "textarea"
                  ? "textbox"
                  : tag === "select"
                    ? "combobox"
                    : inputType === "checkbox"
                      ? "checkbox"
                      : inputType === "radio"
                        ? "radio"
                        : "textbox");

          const labelledBy = node.getAttribute("aria-labelledby");
          const labelledByText = labelledBy
            ?.split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const label =
            node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
              ? node.labels?.[0]?.textContent
              : undefined;
          const name =
            node.getAttribute("aria-label") ??
            labelledByText ??
            label ??
            node.getAttribute("placeholder") ??
            node.getAttribute("title") ??
            node.textContent ??
            "";
          const value =
            node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
              ? node.value
              : undefined;
          const rawText = node.textContent?.replace(/\s+/g, " ").trim();
          const text =
            rawText === undefined || rawText.length === 0
              ? undefined
              : rawText.length > 240
                ? `${rawText.slice(0, 239)}…`
                : rawText;
          const cleanName = name.replace(/\s+/g, " ").trim();
          const boundedName =
            cleanName.length > 160 ? `${cleanName.slice(0, 159)}…` : cleanName;
          const disabled =
            (node instanceof HTMLButtonElement ||
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLSelectElement) &&
            node.disabled;
          const href = node instanceof HTMLAnchorElement ? node.href : node.getAttribute("href") ?? undefined;
          const checked =
            node instanceof HTMLInputElement && (node.type === "checkbox" || node.type === "radio")
              ? node.checked
              : undefined;
          const selected = node instanceof HTMLOptionElement ? node.selected : undefined;

          return [
            {
              index,
              role,
              name: boundedName.length === 0 ? role : boundedName,
              ...(value === undefined || value.length === 0 ? {} : { value: value.slice(0, 240) }),
              ...(text === undefined ? {} : { text }),
              enabled: !disabled && node.getAttribute("aria-disabled") !== "true",
              ...(href === undefined ? {} : { href }),
              ...(checked === undefined ? {} : { checked }),
              ...(selected === undefined ? {} : { selected }),
            },
          ];
        }).slice(0, Number(limit)),
        MAX_INTERACTIVE_ELEMENTS,
      );
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_SNAPSHOT_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "Could not inspect the page.",
      );
    }

    const output: BrowserSnapshot["elements"] = [];
    for (const [position, element] of elements.entries()) {
      const ref = `e${revision}-${position + 1}`;
      this.references.set(ref, {
        locator: candidates.nth(element.index),
        revision: this.referenceRevision,
        url,
        kind: "element",
      });
      output.push({
        ref,
        role: element.role,
        name: element.name,
        ...(element.value === undefined ? {} : { value: element.value }),
        ...(element.text === undefined ? {} : { text: element.text }),
        enabled: element.enabled,
        ...(element.href === undefined ? {} : { href: element.href }),
        ...(element.checked === undefined ? {} : { checked: element.checked }),
        ...(element.selected === undefined ? {} : { selected: element.selected }),
      });
    }

    const regionLocator = page.locator(REGION_SELECTOR);
    const pageOutline: BrowserPageRegion[] = outline.map(region => {
      const ref = region.ref;
      this.references.set(ref, {
        locator: regionLocator.nth(region.candidateIndex),
        revision,
        url,
        kind: "region",
        regionKind: region.kind,
        ...(region.heading ? { heading: region.heading } : {}),
      });
      return {
        ref,
        kind: region.kind,
        ...(region.heading ? { heading: region.heading } : {}),
        ...(region.preview ? { preview: region.preview } : {}),
        ...(region.rowCount === undefined ? {} : { rowCount: region.rowCount }),
        ...(region.columnCount === undefined ? {} : { columnCount: region.columnCount }),
      };
    });
    const stableRevision = await this.refreshDomRevision(page);
    if (stableRevision !== revision) {
      if (attempt < 2) return this.snapshotInternal(input, attempt + 1);
      throw new GuestRpcError("BROWSER_DOM_UNSTABLE", "The page changed repeatedly while its outline was being read.");
    }

    return {
      url,
      title,
      pageCount: this.context?.pages().length ?? 1,
      revision,
      regionCount: regionIndex.regionCount,
      outlineTruncated: regionIndex.truncated || regionIndex.regionCount > pageOutline.length,
      outline: pageOutline,
      elements: output,
    };
  }

  async read(input: {
    mode?: BrowserReadMode;
    query?: string;
    ref?: string;
    maxChars?: number;
    offset?: number;
    limit?: number;
  } = {}): Promise<BrowserReadResult> {
    return this.withWatchdog(() => this.readInternal(input), "browser.read");
  }

  private async readInternal(input: {
    mode?: BrowserReadMode;
    query?: string;
    ref?: string;
    maxChars?: number;
    offset?: number;
    limit?: number;
  }): Promise<BrowserReadResult> {
    if (input.ref) return this.readContentReference({
      ref: input.ref,
      ...(input.mode === undefined ? {} : { mode: input.mode }),
      ...(input.maxChars === undefined ? {} : { maxChars: input.maxChars }),
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return this.readSemanticContent(input);
  }

  private async readSemanticContent(input: {
    mode?: BrowserReadMode;
    query?: string;
    maxChars?: number;
    maxResults?: number;
  }, attempt = 0): Promise<BrowserReadResult> {
    const page = await this.ensurePage();
    await this.waitForReadableStability(page);
    await this.installReadabilityScript(page);
    await this.refreshDomRevision(page);
    const revision = this.referenceRevision;
    const url = page.url();
    const title = await this.readTitle(page);
    const maxChars = Math.max(1, Math.min(12_000, Math.trunc(input.maxChars ?? DEFAULT_READ_CHARS)));
    const query = input.query?.trim() || undefined;
    const extracted = await this.extractSemanticContent(page, url);
    let selected: BrowserContentBlock[];
    if (query) {
      const ranked = rankBrowserContentBlocks({
        query,
        blocks: extracted.blocks,
        maxResults: input.maxResults ?? 10,
      });
      selected = ranked.results.flatMap(result => {
        const block = this.contentReferences.get(result.ref)?.block;
        if (!block) return [];
        return [{ ...block, relevance: result.relevance }];
      });
    } else {
      const substantive = extracted.blocks.filter(block => !block.boilerplate);
      const boilerplate = extracted.blocks.filter(block => block.boilerplate);
      selected = [...substantive].sort((left, right) => (
        (right.importance ?? 0) - (left.importance ?? 0)
        || this.contentTypePriority(left.type) - this.contentTypePriority(right.type)
        || left.ref.localeCompare(right.ref)
      )).slice(0, 7);
      const chrome = boilerplate[0];
      if (chrome) selected.push(chrome);
    }

    const summaries: BrowserContentSummary[] = [];
    let returnedChars = 0;
    const previewChars = Math.max(160, Math.min(DEFAULT_BLOCK_PREVIEW_CHARS, Math.floor(maxChars / Math.max(1, Math.min(6, selected.length)))));
    for (const block of selected) {
      const summary = this.summarizeContentBlock(block, previewChars);
      const cost = JSON.stringify(summary).length;
      if (summaries.length > 0 && returnedChars + cost > maxChars) break;
      summaries.push(summary);
      returnedChars += cost;
    }
    const sections = summaries.map(summary => ({
      ...(summary.heading ? { heading: summary.heading } : {}),
      text: summary.preview ?? "",
      ref: summary.ref,
    }));
    const stableRevision = await this.refreshDomRevision(page);
    if (stableRevision !== revision || page.url() !== url) {
      if (attempt < 2) return this.readSemanticContent(input, attempt + 1);
      throw new GuestRpcError("BROWSER_DOM_UNSTABLE", "The page changed repeatedly while semantic content was being read.", { httpStatus: 409 });
    }
    return {
      operation: "read",
      url,
      title,
      revision,
      mode: input.mode ?? "readable",
      source: "semantic",
      pageType: extracted.pageType,
      ...(query ? { query } : {}),
      blocks: summaries,
      diagnostics: {
        blockCount: extracted.blocks.length,
        tableCount: extracted.blocks.filter(block => block.type === "table").length,
        selectedRefs: summaries.map(summary => ({ ref: summary.ref, ...(summary.relevance === undefined ? {} : { relevance: summary.relevance }) })),
        extractors: extracted.extractors,
        inaccessibleFrames: extracted.inaccessibleFrames,
      },
      readable: extracted.blocks.some(block => Boolean(
        block.text?.trim() || block.rows?.length || block.items?.length || block.title?.trim()
        || block.snippet?.trim() || block.links?.length || block.fields?.length || block.definitions?.length,
      )),
      sections,
      totalChars: extracted.blocks.reduce((sum, block) => sum + this.contentBlockSize(block), 0),
      returnedChars,
      truncated: extracted.sourceTruncated || summaries.length < selected.length || extracted.blocks.length > summaries.length,
    };
  }

  private async readContentReference(input: {
    ref: string;
    mode?: BrowserReadMode;
    maxChars?: number;
    offset?: number;
    limit?: number;
  }): Promise<BrowserReadResult> {
    const page = await this.ensurePage();
    const reference = await this.resolveContentReference(input.ref);
    const maxChars = Math.max(1, Math.min(12_000, Math.trunc(input.maxChars ?? DEFAULT_READ_CHARS)));
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 20)));
    const full = reference.block;
    let block: BrowserContentBlock = full;
    let hasMore = false;
    if (full.type === "table") {
      const rows = full.rows ?? [];
      block = {
        ...full,
        rows: rows.slice(offset, offset + limit),
        ...(full.cellSpans ? { cellSpans: full.cellSpans.slice(offset, offset + limit) } : {}),
      };
      hasMore = offset + (block.rows?.length ?? 0) < rows.length;
    } else if (full.type === "list") {
      const items = full.items ?? [];
      const selected: string[] = [];
      let itemChars = 0;
      for (const item of items.slice(offset, offset + limit)) {
        const nextChars = JSON.stringify(item).length;
        if (selected.length > 0 && itemChars + nextChars > maxChars) break;
        selected.push(item);
        itemChars += nextChars;
      }
      block = { ...full, items: selected };
      hasMore = offset + (block.items?.length ?? 0) < items.length;
    } else if (["text", "code", "other"].includes(full.type) && full.text !== undefined) {
      const text = full.text;
      block = { ...full, text: text.slice(offset, offset + maxChars) };
      hasMore = offset + (block.text?.length ?? 0) < text.length;
    }
    const summary = this.summarizeContentBlock(block, maxChars);
    if (block.type === "table") {
      const rows: string[][] = [];
      let rowChars = 0;
      for (const row of block.rows ?? []) {
        const nextChars = JSON.stringify(row).length;
        if (rows.length > 0 && rowChars + nextChars > maxChars) break;
        rows.push(row);
        rowChars += nextChars;
      }
      summary.rows = rows;
      summary.offset = offset;
      summary.returnedRowCount = rows.length;
      if (offset + rows.length < (full.rows?.length ?? 0)) {
        summary.nextOffset = offset + rows.length;
        hasMore = true;
      }
      summary.truncated = Boolean(summary.truncated || hasMore);
    } else if (block.type === "list") {
      summary.items = block.items ?? [];
      summary.offset = offset;
      summary.returnedRowCount = summary.items.length;
      if (hasMore) summary.nextOffset = offset + summary.items.length;
      summary.truncated = Boolean(summary.truncated || hasMore);
    } else if (["text", "code", "other"].includes(block.type) && block.text !== undefined) {
      summary.offset = offset;
      summary.returnedChars = block.text.length;
      if (hasMore) summary.nextOffset = offset + block.text.length;
      summary.truncated = Boolean(summary.truncated || hasMore);
    }
    const preview = summary.preview ?? "";
    const stableRevision = await this.refreshDomRevision(page);
    if (stableRevision !== reference.revision || page.url() !== reference.url) {
      throw new GuestRpcError("STALE_CONTENT_REF", `Browser content ref ${input.ref} is no longer available.`, { httpStatus: 409 });
    }
    return {
      operation: "read",
      url: reference.url,
      title: await this.readTitle(page),
      revision: reference.revision,
      mode: input.mode ?? "readable",
      source: "semantic",
      pageType: full.type === "table" ? "data_table" : "generic",
      blocks: [summary],
      diagnostics: {
        blockCount: 1,
        tableCount: full.type === "table" ? 1 : 0,
        selectedRefs: [{ ref: input.ref }],
        extractors: full.source?.extractor ? [full.source.extractor] : ["dom"],
      },
      readable: Boolean(preview),
      sections: [{ ...(summary.heading ? { heading: summary.heading } : {}), text: preview, ref: input.ref }],
      totalChars: this.contentBlockSize(full),
      returnedChars: preview.length,
      truncated: Boolean(full.truncated || hasMore),
    };
  }

  async serializeContentRef(ref: string, format: BrowserContentFormat = "text"): Promise<{
    content: string;
    sourceRef: string;
    sourceType: BrowserContentBlock["type"];
    sourceRevision: number;
    sourceUrl: string;
    format: BrowserContentFormat;
  }> {
    return this.withWatchdog(async () => {
      const reference = await this.resolveContentReference(ref);
      return {
        content: serializeBrowserContentBlock(reference.block, format),
        sourceRef: ref,
        sourceType: reference.block.type,
        sourceRevision: reference.revision,
        sourceUrl: reference.url,
        format,
      };
    }, "browser.serializeContentRef");
  }

  private async extractSemanticContent(page: PlaywrightPage, pageUrl: string): Promise<IndexedSemanticContent> {
    const frames = page.frames();
    const extracted: IndexedSemanticContent = {
      blocks: [],
      pageType: "generic",
      sourceTruncated: false,
      extractors: ["dom"],
      inaccessibleFrames: 0,
    };
    for (const frame of frames) {
      const frameUrl = frame.url();
      const frameName = frame.name();
      try {
        const result = await frame.locator("body").evaluateAll(extractSemanticBrowserBlocks, {
          frameUrl,
          frameName,
          pageUrl: frameUrl || pageUrl,
          readability: true,
        });
        if (frameUrl === pageUrl || extracted.blocks.length === 0) extracted.pageType = result.pageType;
        extracted.sourceTruncated ||= result.sourceTruncated;
        for (const block of result.blocks) extracted.blocks.push(block as BrowserContentBlock);
        if (result.blocks.some(block => block.source?.extractor === "readability")) {
          if (!extracted.extractors.includes("readability")) extracted.extractors.push("readability");
        }
      } catch {
        // A detached or cross-origin frame must not make the top-level read fail.
        extracted.inaccessibleFrames += 1;
      }
    }

    const mainFrame = frames[0];
    const hasUsefulDomBlocks = extracted.blocks.some(block => !block.boilerplate && Boolean(
      block.text?.trim() || block.rows?.length || block.items?.length || block.fields?.length || block.definitions?.length,
    ));
    if (mainFrame && !hasUsefulDomBlocks) {
      try {
        const aria = await mainFrame.locator("body").ariaSnapshotJSON?.({ mode: "ai", depth: 7 });
        if (aria !== undefined) {
          const candidate = extractAccessibleCandidate(aria);
          const represented = extracted.blocks.map(block => [block.text, block.title, block.snippet, ...(block.columns ?? []), ...(block.rows ?? []).flat()]
            .filter(Boolean).join(" ")).join(" ").replace(/\s+/gu, " ").toLocaleLowerCase();
          const uniqueLines = candidate.split("\n").filter(line => {
            const normalized = line.replace(/\s+/gu, " ").trim().toLocaleLowerCase();
            return normalized.length > 4 && !represented.includes(normalized);
          });
          const uniqueText = uniqueLines.join("\n").slice(0, 20_000);
          if (uniqueText.length >= 80) {
            extracted.blocks.push({
              ref: "",
              type: "other",
              text: uniqueText,
              source: { frameUrl: mainFrame.url(), frameName: mainFrame.name(), extractor: "aria" },
              role: "accessibility-tree",
              importance: 0.42,
              boilerplate: false,
            });
            extracted.extractors.push("aria");
            await new Promise(resolve => setTimeout(resolve, 40));
          }
        }
      } catch {
        // Older Playwright builds and inaccessible documents fall back to DOM.
      }
    }

    const seen = new Set<string>();
    const unique = extracted.blocks.filter(block => {
      const key = `${block.type}\u0000${block.headingPath?.join("/") ?? ""}\u0000${(block.text ?? block.title ?? "").replace(/\s+/gu, " ").trim().toLocaleLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    extracted.blocks = unique;
    extracted.extractors = [...new Set(extracted.extractors)];
    extracted.blocks.forEach((block, index) => {
      const ref = `c${this.referenceRevision}-${this.contentSessionId}-${index + 1}`;
      block.ref = ref;
      this.contentReferences.set(ref, { block, revision: this.referenceRevision, url: pageUrl });
    });
    return extracted;
  }

  private contentTypePriority(type: BrowserContentBlock["type"]): number {
    return ({ table: 0, search_result: 1, text: 2, list: 3, definition: 4, form: 5, code: 6, heading: 7, other: 8, navigation: 9 })[type];
  }

  private contentBlockSize(block: BrowserContentBlock): number {
    return JSON.stringify(block).length;
  }

  private summarizeContentBlock(block: BrowserContentBlock, previewLimit: number): BrowserContentSummary {
    const previewText = block.type === "table"
      ? [block.caption || block.headingPath?.join(" / ") || block.heading, (block.columns ?? []).join(" | "), ...(block.rows ?? []).slice(0, 2).map(row => row.join(" | "))].filter(Boolean).join("\n")
      : block.type === "search_result"
        ? [block.title, block.href, block.snippet].filter(Boolean).join("\n")
        : blockText(block);
    const preview = previewText.length > previewLimit ? `${previewText.slice(0, Math.max(1, previewLimit - 1))}…` : previewText;
    return {
      ref: block.ref,
      type: block.type,
      ...(block.heading ? { heading: block.heading } : {}),
      ...(block.headingPath ? { headingPath: block.headingPath } : {}),
      ...(block.source ? { source: block.source } : {}),
      ...(block.role ? { role: block.role } : {}),
      ...(block.importance === undefined ? {} : { importance: block.importance }),
      ...(block.relevance === undefined ? {} : { relevance: block.relevance }),
      ...(block.boilerplate === undefined ? {} : { boilerplate: block.boilerplate }),
      ...(block.caption ? { caption: block.caption } : {}),
      ...(block.columns ? { columns: block.columns } : {}),
      ...(block.type === "table" ? { rows: (block.rows ?? []).slice(0, 2), rowCount: block.rowCount, columnCount: block.columnCount } : {}),
      ...(block.cellSpans ? { cellSpans: block.cellSpans.slice(0, 2) } : {}),
      ...(block.type === "list" ? { items: (block.items ?? []).slice(0, 5), rowCount: block.rowCount } : {}),
      ...(block.type === "definition" ? { definitions: (block.definitions ?? []).slice(0, 5) } : {}),
      ...(block.type === "form" ? { fields: (block.fields ?? []).slice(0, 8) } : {}),
      ...(block.links ? { links: block.links.slice(0, 8) } : {}),
      ...(block.title ? { title: block.title } : {}),
      ...(block.href ? { href: block.href } : {}),
      ...(block.snippet ? { snippet: block.snippet.slice(0, 400) } : {}),
      ...(block.language ? { language: block.language } : {}),
      ...(block.truncated === undefined ? {} : { truncated: block.truncated }),
      ...(preview ? { preview } : {}),
    };
  }

  private async resolveContentReference(ref: string): Promise<SerializableContentReference> {
    const page = await this.ensurePage();
    await this.refreshDomRevision(page);
    const reference = this.contentReferences.get(ref);
    if (!reference || reference.revision !== this.referenceRevision || reference.url !== page.url()) {
      this.contentReferences.delete(ref);
      throw new GuestRpcError("STALE_CONTENT_REF", `Browser content ref ${ref} is unknown or stale. Read the current page again to obtain a fresh ref.`, { httpStatus: 409 });
    }
    return reference;
  }

  private async waitForReadableStability(page: PlaywrightPage): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 1_200 });
    } catch {
      // DOM observation below handles pages that never signal this state.
    }
    const deadline = Date.now() + 1_800;
    let previous = "";
    let stableSamples = 0;
    while (Date.now() < deadline) {
      const signature = await page.locator("body").evaluateAll(nodes => {
        const body = nodes[0];
        if (!(body instanceof HTMLElement)) return "empty";
        const tables = Array.from(body.querySelectorAll("table,[role='table'],[role='grid'],[role='treegrid']"))
          .reduce((sum, table) => sum + table.querySelectorAll("tr,[role='row']").length, 0);
        const state = window as Window & { __helmDomRevision?: number };
        return `${body.innerText.length}:${tables}:${state.__helmDomRevision ?? 0}`;
      }).catch(() => "empty");
      if (signature === previous && signature !== "empty:0:0") stableSamples += 1;
      else stableSamples = 0;
      if (stableSamples >= 3) return;
      previous = signature;
      await new Promise(resolve => setTimeout(resolve, 120));
    }
  }

  private async installReadabilityScript(page: PlaywrightPage): Promise<void> {
    for (const frame of page.frames()) {
      try {
        const shouldInject = await frame.locator("body").evaluateAll(nodes => {
          if (!(nodes[0] instanceof HTMLElement)) return false;
          const body = nodes[0];
          const proseLength = Array.from(body.querySelectorAll("article p, main p, [role='main'] p, p"))
            .reduce((sum, paragraph) => sum + ((paragraph as HTMLElement).innerText?.length ?? 0), 0);
          const tableCount = body.querySelectorAll("table,[role='table'],[role='grid'],[role='treegrid']").length;
          const formCount = body.querySelectorAll("form,[role='form']").length;
          const article = body.querySelector("article,[itemprop='articleBody']");
          const installed = typeof (window as Window & { __helmReadability?: unknown }).__helmReadability === "function";
          return { shouldInject: !installed && tableCount === 0 && formCount === 0 && (Boolean(article) || proseLength >= 700), installed };
        });
        if (!shouldInject || typeof shouldInject !== "object" || !shouldInject.shouldInject) continue;
        const script = await frame.addScriptTag({ content: this.readabilitySource });
        await script.evaluate(element => {
          if (element instanceof HTMLScriptElement) element.remove();
          return true;
        });
        // Let the page-local MutationObserver observe the injected and
        // removed script before refs are bound to this page revision.
        await new Promise(resolve => setTimeout(resolve, 40));
      } catch {
        // Some frames enforce a policy that disallows local script injection.
      }
    }
  }

  async search(input: {
    query: string;
    maxResults?: number;
  }): Promise<BrowserSearchPageResult> {
    return this.withWatchdog(() => this.searchInternal(input), "browser.search");
  }

  async open(input: { ref: string; linkIndex?: number }): Promise<BrowserOpenResult> {
    return this.withWatchdog(async () => {
      const reference = await this.resolveContentReference(input.ref);
      const block = reference.block;
      const link = input.linkIndex === undefined
        ? undefined
        : block.links?.[input.linkIndex];
      if (input.linkIndex !== undefined && !link) {
        throw new GuestRpcError("INVALID_LINK_INDEX", `Content ref ${input.ref} has no link at index ${input.linkIndex}.`, { httpStatus: 400 });
      }
      const observedHref = input.linkIndex === undefined
        ? block.href ?? (block.links?.length === 1 ? block.links[0]?.href : undefined)
        : link?.href;
      if (!observedHref) {
        throw new GuestRpcError(
          block.links && block.links.length > 1 ? "LINK_INDEX_REQUIRED" : "CONTENT_REF_HAS_NO_LINK",
          block.links && block.links.length > 1
            ? `Content ref ${input.ref} contains multiple links; specify linkIndex.`
            : `Content ref ${input.ref} does not contain an observed destination URL.`,
          { httpStatus: 400 },
        );
      }
      let destination: URL;
      try {
        destination = new URL(observedHref);
      } catch {
        throw new GuestRpcError("INVALID_OBSERVED_LINK", "The observed link is not an absolute URL.", { httpStatus: 400 });
      }
      if (!(["http:", "https:"] as string[]).includes(destination.protocol)) {
        throw new GuestRpcError("INVALID_OBSERVED_LINK", "Observed page links must use HTTP or HTTPS.", { httpStatus: 400 });
      }
      const state = await this.navigate({ url: observedHref });
      return {
        ref: input.ref,
        openedHref: observedHref,
        sourceType: block.type,
        ...state,
      };
    }, "browser.open");
  }

  private async searchInternal(input: {
    query: string;
    maxResults?: number;
  }, attempt = 0): Promise<BrowserSearchPageResult> {
    const result = await this.readSemanticContent({
      query: input.query,
      maxChars: 12_000,
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
    }, attempt);
    const results = result.blocks ?? [];
    return {
      operation: "search",
      searchCompleted: true,
      url: result.url,
      title: result.title,
      revision: result.revision,
      query: input.query,
      semanticBlockCount: result.diagnostics?.blockCount ?? 0,
      matchCount: results.length,
      pageReadable: result.readable,
      message: results.length > 0
        ? `Search completed successfully. Found ${results.length} matching semantic block${results.length === 1 ? "" : "s"}.`
        : "Search completed successfully. No semantic content matched the query.",
      results,
    };
  }

  async inspectRegion(input: {
    ref: string;
    format?: "auto" | "text" | "table" | "links";
    maxChars?: number;
    offset?: number;
    limit?: number;
  }): Promise<BrowserRegionInspection> {
    return this.withWatchdog(() => this.inspectRegionInternal(input), "browser.inspectRegion");
  }

  private async inspectRegionInternal(input: {
    ref: string;
    format?: "auto" | "text" | "table" | "links";
    maxChars?: number;
    offset?: number;
    limit?: number;
  }): Promise<BrowserRegionInspection> {
    const page = await this.ensurePage();
    const reference = await this.resolveReference(input.ref);
    if (reference.kind !== "region" || reference.regionKind === undefined) {
      throw new GuestRpcError("INVALID_REGION_REF", `${input.ref} is not a semantic region ref.`, { httpStatus: 400 });
    }
    const maxChars = Math.max(1_000, Math.min(12_000, Math.trunc(input.maxChars ?? DEFAULT_REGION_CHARS)));
    const offset = Math.max(0, Math.min(1_000_000, Math.trunc(input.offset ?? 0)));
    const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? DEFAULT_TABLE_ROWS)));
    const format = input.format ?? "auto";
    const requestedFormat = format === "auto"
      ? reference.regionKind === "table" ? "table" : "text"
      : format === "table" && reference.regionKind !== "table" ? "text" : format;
    const sourceRevision = reference.revision;
    const regionInfo = await reference.locator.evaluateAll((nodes, options) => {
      const node = nodes[0];
      if (!(node instanceof HTMLElement)) return { missing: true as const };
      const maxChars = typeof options === "object" && options !== null && "maxChars" in options
        ? Number((options as { maxChars: number }).maxChars)
        : 12_000;
      const offset = typeof options === "object" && options !== null && "offset" in options
        ? Number((options as { offset: number }).offset)
        : 0;
      const rowLimit = typeof options === "object" && options !== null && "limit" in options
        ? Number((options as { limit: number }).limit)
        : 50;
      const clean = (value: string | null | undefined, max = 1_000) => {
        const normalized = (value ?? "").replace(/\s+/g, " ").trim();
        return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
      };
      const selectedHeading = node.matches("h1,h2,h3,h4,h5,h6,[role='heading']")
        ? node
        : Array.from(node.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']"))
          .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
      const heading = clean(selectedHeading?.innerText, 240);
      if (options && typeof options === "object" && "format" in options && options.format === "links") {
        const anchors = Array.from(node.querySelectorAll("a[href]"));
        const links: Array<{ text: string; href: string }> = [];
        let chars = 0;
        for (const anchor of anchors) {
          if (!(anchor instanceof HTMLAnchorElement)) continue;
          const link = { text: clean(anchor.innerText || anchor.getAttribute("aria-label"), 240), href: anchor.href.slice(0, 1_000) };
          const size = JSON.stringify(link).length;
          if (!link.text && !link.href) continue;
          if (chars + size > maxChars) break;
          links.push(link);
          chars += size;
        }
        return { heading, links, linkCount: anchors.length, truncated: links.length < anchors.length };
      }
      if (options && typeof options === "object" && "format" in options && options.format === "table") {
        const table = node.matches("table") ? node : node.querySelector("table");
        if (table instanceof HTMLTableElement) {
        const allRows = Array.from(table.querySelectorAll("tr"));
        const headerRow = allRows.find(row => row.querySelector("th")) ?? allRows[0];
          const allHeaderCells = headerRow ? Array.from(headerRow.querySelectorAll("th,td")) : [];
          const columnCount = Math.max(0, ...allRows.map(row => row.querySelectorAll("th,td").length));
          const maxColumns = Math.max(1, Math.min(80, Math.floor(maxChars / 100)));
          const maxHeaderChars = Math.max(16, Math.min(128, Math.floor(maxChars / (maxColumns * 2))));
          const columns: string[] = [];
          let chars = 2;
          for (const cell of allHeaderCells.slice(0, maxColumns)) {
            const value = clean(cell.textContent, maxHeaderChars);
            const size = JSON.stringify(value).length + (columns.length === 0 ? 0 : 1);
            if (chars + size > maxChars * 0.45) break;
            columns.push(value);
            chars += size;
          }
          let truncated = columns.length < columnCount;
          const rows: string[][] = [];
          const maxCellChars = Math.max(16, Math.min(256, Math.floor(maxChars * 0.4 / Math.max(1, columns.length))));
          let dataRowIndex = 0;
          for (const row of allRows) {
            if (row === headerRow) continue;
            const cells = Array.from(row.querySelectorAll("th,td")).slice(0, columns.length).map(cell => clean(cell.textContent, maxCellChars));
            if (cells.length === 0) continue;
            const currentIndex = dataRowIndex;
            dataRowIndex += 1;
            if (currentIndex < offset) continue;
            if (rows.length >= rowLimit) {
              truncated = true;
              break;
            }
            const size = JSON.stringify(cells).length + 1;
            if (chars + size > maxChars) {
              truncated = true;
              break;
            }
            rows.push(cells);
            chars += size;
          }
          const dataRowCount = allRows.filter(row => row !== headerRow && row.querySelector("th,td")).length;
          return {
            heading,
            columns,
            rows,
            rowCount: dataRowCount,
            returnedRowCount: rows.length,
            offset,
            columnCount,
            truncated: truncated || offset > 0 || offset + rows.length < dataRowCount,
          };
        }
      }
      const text = node.innerText.replace(/\r\n?/g, "\n").trim();
      return { heading, text: text.slice(0, maxChars), truncated: text.length > maxChars };
    }, { format: requestedFormat, maxChars, offset, limit });
    if (regionInfo.missing) {
      throw new GuestRpcError("STALE_REGION_REF", `Browser region ${input.ref} is no longer available.`, { httpStatus: 409 });
    }
    const stableRevision = await this.refreshDomRevision(page);
    if (stableRevision !== sourceRevision || page.url() !== reference.url) {
      throw new GuestRpcError("STALE_REGION_REF", `Browser region ${input.ref} changed while it was being inspected.`, { httpStatus: 409 });
    }
    const common = {
      url: page.url(),
      title: await this.readTitle(page),
      revision: this.referenceRevision,
      ref: input.ref,
      kind: reference.regionKind,
      ...(reference.heading || regionInfo.heading ? { heading: reference.heading ?? regionInfo.heading } : {}),
    };
    if (requestedFormat === "links") {
      return { ...common, format: "links", links: regionInfo.links ?? [], linkCount: regionInfo.linkCount ?? 0, truncated: regionInfo.truncated ?? false };
    }
    if (requestedFormat === "table" && reference.regionKind === "table" && "columns" in regionInfo) {
      const tableInfo = regionInfo as {
        columns: string[];
        rows: string[][];
        rowCount: number;
        returnedRowCount: number;
        offset: number;
        columnCount: number;
        truncated: boolean;
      };
      return {
        ...common,
        kind: "table",
        format: "table",
        columns: tableInfo.columns,
        rows: tableInfo.rows,
        rowCount: tableInfo.rowCount,
        returnedRowCount: tableInfo.returnedRowCount,
        offset: tableInfo.offset,
        columnCount: tableInfo.columnCount,
        truncated: tableInfo.truncated,
      };
    }
    return { ...common, format: "text", text: regionInfo.text ?? "", truncated: regionInfo.truncated ?? false };
  }

  async download(input: { ref?: string; url?: string }): Promise<{
    sourceUrl: string;
    finalUrl?: string;
    suggestedFilename?: string;
    savedPath?: string;
    size?: number;
    context?: string;
    startedAt: string;
  }> {
    const page = await this.ensurePage();
    const startedAt = new Date().toISOString();
    const reference = input.ref === undefined ? undefined : await this.resolveReference(input.ref);
    if (reference && reference.kind !== "element") {
      throw new GuestRpcError("INVALID_ELEMENT_REF", "browser.download requires an interactive element ref.", { httpStatus: 400 });
    }
    const rawSourceUrl = input.url
      ?? (reference === undefined ? page.url() : await reference.locator.getAttribute("href"))
      ?? page.url();
    let sourceUrl = rawSourceUrl;
    try {
      sourceUrl = new URL(rawSourceUrl, page.url()).toString();
    } catch {
      // The download event remains authoritative even when a page exposes an
      // unusual non-URL href. Preserve the raw source for diagnostics.
    }
    const downloadPromise = page.waitForEvent("download", { timeout: 30_000 });
    try {
      if (input.ref !== undefined) {
        if (!reference) throw new GuestRpcError("STALE_ELEMENT_REF", `Browser ref ${input.ref} is no longer valid.`);
        await reference.locator.click({ timeout: 15_000 });
      } else if (input.url !== undefined) {
        try {
          await page.goto(safeUrl(input.url), { waitUntil: "commit", timeout: 30_000 });
        } catch (error) {
          // Chromium reports downloads as a navigation error in some versions;
          // the download event below remains the authoritative result.
          if (!/download|interrupted|navigation/iu.test(error instanceof Error ? error.message : String(error))) {
            throw error;
          }
        }
      }
      const download = await downloadPromise;
      const suggestedFilename = download.suggestedFilename();
      const savedPath = await this.sandbox.downloadPath(suggestedFilename);
      await download.saveAs(savedPath);
      const state = await this.sandbox.stat(savedPath);
      this.invalidateReferences();
      return {
        sourceUrl,
        finalUrl: download.url(),
        suggestedFilename,
        savedPath,
        size: state.size,
        ...(this.context === undefined ? {} : { context: "persistent-chromium" }),
        startedAt,
      };
    } catch (error) {
      this.invalidateReferences();
      throw new GuestRpcError(
        "BROWSER_DOWNLOAD_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser download could not be completed.",
      );
    }
  }

  async click(ref: string): Promise<BrowserState> {
    const reference = await this.resolveReference(ref);
    if (reference.kind !== "element") {
      throw new GuestRpcError("INVALID_ELEMENT_REF", "browser.click requires an interactive element ref.", { httpStatus: 400 });
    }
    try {
      await reference.locator.click({ timeout: 15_000 });
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_CLICK_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser element could not be clicked.",
      );
    } finally {
      this.invalidateReferences();
    }
    return this.getState();
  }

  async clickAt(x: number, y: number): Promise<BrowserState> {
    const page = await this.ensurePage();
    try {
      await page.mouse.click(x, y);
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_CLICK_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser coordinate could not be clicked.",
      );
    } finally {
      this.invalidateReferences();
    }
    return this.getState();
  }

  async type(ref: string, text: string, clear: boolean): Promise<BrowserState> {
    const reference = await this.resolveReference(ref);
    if (reference.kind !== "element") {
      throw new GuestRpcError("INVALID_ELEMENT_REF", "browser.type requires an interactive element ref.", { httpStatus: 400 });
    }
    try {
      if (clear) {
        await reference.locator.fill(text, { timeout: 15_000 });
      } else {
        await reference.locator.pressSequentially(text, { timeout: 15_000 });
      }
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_TYPE_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser element could not receive text.",
      );
    } finally {
      this.invalidateReferences();
    }
    return this.getState();
  }

  async diagnostics(): Promise<{ playwright: boolean; ready: boolean; visible: true }> {
    let playwright = false;
    try {
      await loadPlaywright();
      playwright = true;
    } catch (error) {
      if (!(error instanceof GuestRpcError) || error.code !== "PLAYWRIGHT_UNAVAILABLE") throw error;
    }
    return { playwright, ready: this.context !== undefined, visible: true };
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.invalidateReferences();
    if (context !== undefined) {
      await context.close().catch(() => undefined);
    }
  }

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.context !== undefined && this.page !== undefined) {
      try {
        if (!this.page.isClosed?.()) return this.page;
      } catch {
        // Treat an unusable page exactly like a closed browser session.
      }
      await this.resetContext();
    }

    const module = await loadPlaywright();
    const profile = await this.sandbox.ensureDirectory(
      this.options.profilePath ?? ".config/helm-chromium",
    );
    const contextOptions: {
      headless: boolean;
      viewport: null;
      executablePath?: string;
      args?: readonly string[];
    } = {
      headless: this.options.headless ?? false,
      viewport: null,
    };
    const executablePath = this.options.executablePath ?? process.env.HELM_CHROMIUM_PATH;
    if (executablePath !== undefined && executablePath.length > 0) {
      contextOptions.executablePath = executablePath;
    }
    if (this.options.extraArgs !== undefined) {
      contextOptions.args = this.options.extraArgs;
    }

    try {
      this.context = await module.chromium.launchPersistentContext(profile, contextOptions);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.on("framenavigated", () => this.invalidateReferences());
      this.page.on("load", () => {
        this.loading = false;
        this.invalidateReferences();
      });
      return this.page;
    } catch (error) {
      this.context = undefined;
      this.page = undefined;
      throw browserLaunchError(error);
    }
  }

  private async resolveReference(ref: string): Promise<BrowserReference> {
    const page = await this.ensurePage();
    await this.refreshDomRevision(page);
    const entry = this.references.get(ref);
    const code = ref.startsWith("r") ? "STALE_REGION_REF" : "STALE_ELEMENT_REF";
    if (entry === undefined) {
      throw new GuestRpcError(code, `Unknown or expired browser ref: ${ref}.`, { httpStatus: 409 });
    }
    const currentUrl = page.url();
    if (entry.revision !== this.referenceRevision || entry.url !== currentUrl) {
      this.references.delete(ref);
      throw new GuestRpcError(code, `Browser ref ${ref} is no longer valid.`, { httpStatus: 409 });
    }
    return entry;
  }

  private invalidateReferences(): void {
    this.referenceRevision += 1;
    this.references.clear();
    this.contentReferences.clear();
    this.referenceUrl = "";
    this.lastDomMutationCount = undefined;
    this.lastFrameMutationSignature = undefined;
    this.outlineCache = undefined;
  }

  private async refreshDomRevision(page: PlaywrightPage): Promise<number> {
    let mutationCount = 0;
    try {
      mutationCount = await page.locator("body").evaluateAll((nodes) => {
        const body = nodes[0];
        if (!(body instanceof HTMLElement)) return 0;
        const state = window as Window & {
          __helmDomRevision?: number;
          __helmDomObserver?: MutationObserver;
        };
        if (!state.__helmDomObserver) {
          state.__helmDomRevision = 0;
          const observer = new MutationObserver(() => {
            state.__helmDomRevision = (state.__helmDomRevision ?? 0) + 1;
          });
          observer.observe(document.documentElement ?? body, {
            subtree: true,
            childList: true,
            characterData: true,
            attributes: true,
            attributeFilter: ["aria-label", "aria-labelledby", "aria-disabled", "class", "disabled", "hidden", "href", "role", "style", "value"],
          });
          state.__helmDomObserver = observer;
        }
        return state.__helmDomRevision ?? 0;
      });
    } catch {
      // A page without a readable body still has navigation and action revisions.
    }
    const frameMutations: string[] = [];
    for (const frame of page.frames()) {
      try {
        const count = await frame.locator("body").evaluateAll(nodes => {
          const body = nodes[0];
          if (!(body instanceof HTMLElement)) return 0;
          const state = window as Window & {
            __helmDomRevision?: number;
            __helmDomObserver?: MutationObserver;
          };
          if (!state.__helmDomObserver) {
            state.__helmDomRevision = 0;
            const observer = new MutationObserver(() => {
              state.__helmDomRevision = (state.__helmDomRevision ?? 0) + 1;
            });
            observer.observe(document.documentElement ?? body, {
              subtree: true,
              childList: true,
              characterData: true,
              attributes: true,
              attributeFilter: ["aria-label", "aria-labelledby", "aria-disabled", "class", "disabled", "hidden", "href", "role", "style", "value"],
            });
            state.__helmDomObserver = observer;
          }
          return state.__helmDomRevision ?? 0;
        });
        frameMutations.push(`${frame.url()}#${count}`);
      } catch {
        frameMutations.push(`${frame.url()}#inaccessible`);
      }
    }
    const frameMutationSignature = frameMutations.join("|");
    const url = page.url();
    if (this.referenceUrl.length > 0 && this.referenceUrl !== url) this.invalidateReferences();
    if (this.lastDomMutationCount !== undefined && this.lastDomMutationCount !== mutationCount) {
      this.invalidateReferences();
    }
    if (this.lastFrameMutationSignature !== undefined && this.lastFrameMutationSignature !== frameMutationSignature) {
      this.invalidateReferences();
    }
    this.referenceUrl = url;
    this.lastDomMutationCount = mutationCount;
    this.lastFrameMutationSignature = frameMutationSignature;
    return this.referenceRevision;
  }

  private async getRegionRecords(page: PlaywrightPage): Promise<{
    records: PageRegionRecord[];
    regionCount: number;
    truncated: boolean;
  }> {
    const revision = this.referenceRevision;
    if (this.outlineCache?.revision === revision) return this.outlineCache;
    const candidates = page.locator(REGION_SELECTOR);
    const result = await candidates.evaluateAll((nodes, rawLimit) => {
      const regionLimit = Math.max(1, Number(rawLimit) || 1_200);
      const clean = (value: string | null | undefined, max = 220): string => {
        const normalized = (value ?? '').replace(/\s+/gu, ' ').trim();
        return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
      };
      const kindOf = (node: HTMLElement): BrowserRegionKind => {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        if (/^h[1-6]$/u.test(tag) || role === 'heading') return 'heading';
        if (tag === 'article' || role === 'article') return 'article';
        if (tag === 'table' || role === 'table') return 'table';
        if (tag === 'ul' || tag === 'ol' || role === 'list') return 'list';
        if (tag === 'form' || role === 'form') return 'form';
        if (tag === 'nav' || role === 'navigation') return 'navigation';
        if (tag === 'footer' || role === 'contentinfo') return 'footer';
        if (tag === 'aside' || role === 'complementary') return 'aside';
        if (tag === 'main' || tag === 'section' || role === 'main' || role === 'region') return 'section';
        return 'text';
      };
      const visible = (node: HTMLElement): boolean => {
        if (node.hidden || node.getAttribute('aria-hidden')?.toLowerCase() === 'true') return false;
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const priority = (node: unknown): number => {
        if (!(node instanceof HTMLElement)) return 99;
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute('role');
        if (tag === 'table' || role === 'table') return 0;
        if (tag === 'main' || tag === 'article' || tag === 'section' || role === 'main' || role === 'article' || role === 'region') return 1;
        if (/^h[1-6]$/u.test(tag) || role === 'heading') return 2;
        if (tag === 'ul' || tag === 'ol' || role === 'list' || tag === 'form' || role === 'form') return 3;
        if (tag === 'nav' || role === 'navigation' || tag === 'footer' || role === 'contentinfo' || tag === 'aside' || role === 'complementary') return 5;
        if (tag === 'div') return 6;
        return 4;
      };
      const headings = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement
        && (/^H[1-6]$/u.test(node.tagName) || node.getAttribute('role') === 'heading'));
      const structuralSelector = "main,article,section,table,ul,ol,form,nav,aside,footer,h1,h2,h3,h4,h5,h6,[role='main'],[role='article'],[role='region'],[role='navigation'],[role='contentinfo'],[role='complementary'],[role='list'],[role='form'],p,blockquote,pre,dl";
      const candidateIndexes = Array.from({ length: nodes.length }, (_, index) => index)
        .sort((left, right) => priority(nodes[left]) - priority(nodes[right]) || left - right);
      const records: Array<{
        candidateIndex: number;
        kind: BrowserRegionKind;
        heading?: string;
        preview?: string;
        rowCount?: number;
        columnCount?: number;
        domOrder: number;
      }> = [];
      let visibleCount = 0;
      let truncated = false;
      for (const candidateIndex of candidateIndexes) {
        if (records.length >= regionLimit) {
          truncated = true;
          break;
        }
        const node = nodes[candidateIndex];
        if (!(node instanceof HTMLElement) || !visible(node)) continue;
        const tag = node.tagName.toLowerCase();
        const text = node.innerText.replace(/\s+/gu, ' ').trim();
        if (tag === 'div') {
          if (text.length < 120 || node.querySelector(structuralSelector)) continue;
          const childDivHasText = Array.from(node.querySelectorAll('div')).some(child => child.innerText.trim().length >= 120);
          if (childDivHasText) continue;
        }
        if (!text) continue;
        const kind = kindOf(node);
        let headingNode: HTMLElement | undefined;
        if (kind === 'heading') headingNode = node;
        else headingNode = Array.from(node.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]'))
          .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
        if (!headingNode) {
          const regionContainer = node.closest('section,article,main,[role="main"],[role="region"]');
          for (const candidate of headings) {
            const followsNode = Boolean(candidate.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (!followsNode) continue;
            const headingContainer = candidate.closest('section,article,main,[role="main"],[role="region"]');
            if (headingContainer === regionContainer || headingContainer?.contains(node)) headingNode = candidate;
          }
        }
        const heading = clean(headingNode?.innerText, 160);
        const rows = kind === 'table' ? Array.from(node.querySelectorAll('tr')) : [];
        const headerRow = rows.find(row => row.querySelector('th')) ?? rows[0];
        const dataRows = rows.filter(row => row !== headerRow && row.querySelector('th,td'));
        const columnCount = Math.max(0, ...rows.map(row => row.querySelectorAll('th,td').length));
        const tableHeaders = headerRow ? Array.from(headerRow.querySelectorAll('th,td')).map(cell => clean(cell.textContent, 120)) : [];
        const previewSource = kind === 'table' && tableHeaders.length > 0
          ? `${tableHeaders.join(' ')} ${dataRows[0]?.innerText ?? ''}`
          : text;
        const preview = clean(previewSource, 180);
        records.push({
          candidateIndex,
          kind,
          ...(heading ? { heading } : {}),
          ...(preview ? { preview } : {}),
          ...(kind === 'table' ? { rowCount: dataRows.length, columnCount } : {}),
          domOrder: candidateIndex,
        });
        visibleCount += 1;
      }
      return { records, regionCount: visibleCount, truncated: truncated || nodes.length > regionLimit };
    }, MAX_INDEXED_REGIONS);
    const records: PageRegionRecord[] = result.records.map(record => ({
      ref: `r${revision}-${record.candidateIndex + 1}`,
      kind: record.kind,
      ...(record.heading ? { heading: record.heading } : {}),
      ...(record.preview ? { preview: record.preview } : {}),
      ...(record.rowCount === undefined ? {} : { rowCount: record.rowCount }),
      ...(record.columnCount === undefined ? {} : { columnCount: record.columnCount }),
      domOrder: record.domOrder,
      candidateIndex: record.candidateIndex,
    }));
    const normalized = { records, regionCount: result.regionCount, truncated: result.truncated };
    this.outlineCache = { revision, ...normalized };
    return normalized;
  }

  private async navigatePage(
    page: PlaywrightPage,
    url: string,
    waitUntil: WaitUntil,
    timeoutMs: number,
  ): Promise<BrowserState> {
    await page.goto(url, { waitUntil, timeout: timeoutMs });
    this.loading = false;
    await this.readTitle(page);
    return this.getState();
  }

  private async resetContext(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.invalidateReferences();
    if (!context) return;
    const close = context.close().catch(() => undefined);
    await Promise.race([
      close,
      new Promise<void>(resolve => setTimeout(resolve, BROWSER_CONTEXT_RESET_TIMEOUT_MS)),
    ]);
  }

  private async withWatchdog<T>(operation: () => Promise<T>, name: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timer = setTimeout(() => reject(new BrowserOperationTimeout(name)), BROWSER_OPERATION_TIMEOUT_MS);
        }),
      ]);
    } catch (error) {
      if (error instanceof BrowserOperationTimeout) {
        await this.resetContext();
        throw new GuestRpcError(
          "BROWSER_OPERATION_TIMEOUT",
          `${name} exceeded ${BROWSER_OPERATION_TIMEOUT_MS} ms; the browser context was reset.`,
        );
      }
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async readTitle(page: PlaywrightPage): Promise<string> {
    try {
      return (await page.title()).slice(0, 1_000);
    } catch {
      return "";
    }
  }

  private async stateWithoutThrowing(page: PlaywrightPage): Promise<BrowserState> {
    let url = "";
    try {
      url = page.url();
    } catch {
      // The browser may have disappeared between the tool failure and this
      // diagnostic snapshot.
    }
    return {
      ready: this.context !== undefined && this.page !== undefined,
      visible: true,
      url,
      title: await this.readTitle(page),
      loading: this.loading,
      pageCount: this.context?.pages().length ?? 1,
      revision: this.referenceRevision,
    };
  }
}

function outlinePriority(kind: BrowserRegionKind): number {
  switch (kind) {
    case "table": return 0;
    case "heading": return 1;
    case "article":
    case "section": return 2;
    case "form":
    case "list": return 3;
    case "navigation":
    case "aside":
    case "footer": return 4;
    case "text": return 5;
  }
}
