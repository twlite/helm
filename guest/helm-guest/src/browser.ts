import { GuestRpcError } from "./errors";
import type { GuestSandbox } from "./sandbox";
import { normalizeBrowserUrl } from "../../../packages/shared/src/browser-url";
import type {
  BrowserPageRegion,
  BrowserRegionInspection,
  BrowserRegionKind,
  BrowserSearchPageResult,
  BrowserSnapshot as SharedBrowserSnapshot,
} from "../../../packages/shared/src/types";
import {
  rankPageRegions,
  type IndexedBrowserRegion,
} from "../../../packages/shared/src/browser-perception";

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
  getAttribute(name: string): Promise<string | null>;
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
  mouse: { click(x: number, y: number): Promise<void> };
  waitForEvent(event: "download", options?: { timeout?: number }): Promise<PlaywrightDownload>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  waitForLoadState(state?: WaitUntil, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
  isClosed?(): boolean;
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

interface PageRegionRecord extends IndexedBrowserRegion {
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
const MAX_SEARCH_INDEX_CHARS = 1_024_000;
const MAX_SEARCH_REGION_CHARS = 800;
const DEFAULT_EXTRACT_CHARS = 6_000;
const MAX_EXTRACT_CHARS = 8_000;
const DEFAULT_REGION_CHARS = 8_000;
const DEFAULT_TABLE_ROWS = 50;
const BROWSER_OPERATION_TIMEOUT_MS = 10_000;
const BROWSER_CONTEXT_RESET_TIMEOUT_MS = 1_000;

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

export class BrowserController {
  private context: PlaywrightContext | undefined;
  private page: PlaywrightPage | undefined;
  private loading = false;
  private referenceRevision = 0;
  private referenceUrl = "";
  private lastDomMutationCount: number | undefined;
  private references = new Map<string, BrowserReference>();
  private outlineCache: { revision: number; records: PageRegionRecord[]; regionCount: number; truncated: boolean } | undefined;
  private searchCache: { revision: number; query: string; records: PageRegionRecord[]; regionCount: number; truncated: boolean } | undefined;

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
    const regionIndex = await this.getRegionRecords(page, false);
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

  async searchPage(input: {
    query: string;
    kinds?: BrowserRegionKind[];
    maxResults?: number;
  }): Promise<BrowserSearchPageResult> {
    return this.withWatchdog(() => this.searchPageInternal(input), "browser.searchPage");
  }

  private async searchPageInternal(input: {
    query: string;
    kinds?: BrowserRegionKind[];
    maxResults?: number;
  }, attempt = 0): Promise<BrowserSearchPageResult> {
    const page = await this.ensurePage();
    await this.refreshDomRevision(page);
    const revision = this.referenceRevision;
    const url = page.url();
    const title = await this.readTitle(page);
    const indexed = await this.getRegionRecords(page, true, input.query);
    const ranked = rankPageRegions({
      query: input.query,
      regions: indexed.records,
      ...(input.kinds ? { kinds: input.kinds } : {}),
      ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
    });
    const regionLocator = page.locator(REGION_SELECTOR);
    for (const result of ranked.results) {
      const record = indexed.records.find(region => region.ref === result.ref);
      if (!record) continue;
      this.references.set(result.ref, {
        locator: regionLocator.nth(record.candidateIndex),
        revision,
        url,
        kind: "region",
        regionKind: record.kind,
        ...(record.heading ? { heading: record.heading } : {}),
      });
    }
    const stableRevision = await this.refreshDomRevision(page);
    if (stableRevision !== revision) {
      if (attempt < 2) return this.searchPageInternal(input, attempt + 1);
      throw new GuestRpcError("BROWSER_DOM_UNSTABLE", "The page changed repeatedly while regions were being searched.");
    }
    return {
      url,
      title,
      revision,
      query: input.query,
      indexedRegionCount: ranked.indexedRegionCount,
      results: ranked.results,
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

  async extractText(input: { query: string; maxChars?: number }): Promise<{
    text: string;
    truncated: boolean;
    url: string;
    title: string;
    query: string;
    matches: number;
  }> {
    return this.withWatchdog(() => this.extractTextInternal(input), "browser.extractText");
  }

  private async extractTextInternal(input: { query: string; maxChars?: number }): Promise<{
    text: string;
    truncated: boolean;
    url: string;
    title: string;
    query: string;
    matches: number;
  }> {
    const page = await this.ensurePage();
    const maxChars = Math.max(1, Math.min(MAX_EXTRACT_CHARS, Math.trunc(input.maxChars ?? DEFAULT_EXTRACT_CHARS)));
    const search = await this.searchPageInternal({ query: input.query, maxResults: 5 });
    const records = this.searchCache?.revision === search.revision && this.searchCache.query === input.query
      ? this.searchCache.records
      : [];
    const sections: string[] = [];
    let chars = 0;
    let truncated = false;
    for (const result of search.results) {
      const record = records.find(candidate => candidate.ref === result.ref);
      if (!record) continue;
      const remaining = maxChars - chars - (sections.length > 0 ? 2 : 0);
      if (remaining <= 0) {
        truncated = true;
        break;
      }

      let content: string;
      if (record.kind === "table") {
        const inspected = await this.inspectRegionInternal({
          ref: record.ref,
          format: "table",
          maxChars: Math.max(1_000, Math.min(12_000, remaining)),
          limit: 30,
        });
        content = JSON.stringify(inspected);
        truncated ||= inspected.format === "table" && inspected.truncated;
      } else {
        content = record.searchText;
        if (record.heading && !content.toLocaleLowerCase().includes(record.heading.toLocaleLowerCase())) {
          content = `${record.heading}\n${content}`;
        }
      }

      const section = record.kind === "table" && result.heading
        ? `${result.heading}\n${content}`
        : content;
      const bounded = section.slice(0, remaining);
      sections.push(bounded);
      chars += bounded.length + (sections.length > 1 ? 2 : 0);
      if (bounded.length < section.length) {
        truncated = true;
        break;
      }
    }
    if (search.results.length > sections.length) truncated = true;
    return {
      text: sections.join("\n\n"),
      truncated,
      url: search.url,
      title: await this.readTitle(page),
      query: input.query,
      matches: search.results.length,
    };
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
    this.referenceUrl = "";
    this.lastDomMutationCount = undefined;
    this.outlineCache = undefined;
    this.searchCache = undefined;
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
    const url = page.url();
    if (this.referenceUrl.length > 0 && this.referenceUrl !== url) this.invalidateReferences();
    if (this.lastDomMutationCount !== undefined && this.lastDomMutationCount !== mutationCount) {
      this.invalidateReferences();
    }
    this.referenceUrl = url;
    this.lastDomMutationCount = mutationCount;
    return this.referenceRevision;
  }

  private async getRegionRecords(page: PlaywrightPage, includeText: boolean, query = ""): Promise<{
    records: PageRegionRecord[];
    regionCount: number;
    truncated: boolean;
  }> {
    const revision = this.referenceRevision;
    const cache = includeText
      ? this.searchCache?.revision === revision && this.searchCache.query === query ? this.searchCache : undefined
      : this.outlineCache;
    if (cache) return cache;
    if (includeText && this.outlineCache?.revision === revision) {
      // The outline index is deliberately text-light; search builds its own
      // local searchable region data only when requested.
    }
    const candidates = page.locator(REGION_SELECTOR);
    const result = await candidates.evaluateAll((nodes, options) => {
      const includeText = typeof options === "object" && options !== null && "includeText" in options
        ? Boolean((options as { includeText: boolean }).includeText)
        : false;
      const regionLimit = typeof options === "object" && options !== null && "limit" in options
        ? Number((options as { limit: number }).limit)
        : 1_200;
      const query = typeof options === "object" && options !== null && "query" in options
        ? String((options as { query: string }).query)
        : "";
      const maxSearchChars = typeof options === "object" && options !== null && "maxSearchChars" in options
        ? Number((options as { maxSearchChars: number }).maxSearchChars)
        : 800;
      const totalSearchCharsLimit = typeof options === "object" && options !== null && "totalSearchCharsLimit" in options
        ? Number((options as { totalSearchCharsLimit: number }).totalSearchCharsLimit)
        : 256_000;
      const queryTokens = [...new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])]
        .filter(token => token.length > 1);
      const excerpt = (value: string): string => {
        if (!includeText) return "";
        if (queryTokens.length === 0) return value.slice(0, maxSearchChars);
        const lower = value.toLocaleLowerCase();
        const windows: Array<{ start: number; end: number }> = [];
        for (const token of queryTokens) {
          let position = 0;
          let found = 0;
          while (found < 3) {
            const match = lower.indexOf(token, position);
            if (match < 0) break;
            windows.push({ start: Math.max(0, match - 100), end: Math.min(value.length, match + token.length + 180) });
            position = match + token.length;
            found += 1;
          }
        }
        windows.sort((left, right) => left.start - right.start);
        let output = "";
        let consumedUntil = -1;
        for (const window of windows) {
          if (window.end <= consumedUntil) continue;
          const start = Math.max(window.start, consumedUntil);
          const piece = `${output.length > 0 && start > consumedUntil ? " … " : ""}${value.slice(start, window.end)}`;
          const remaining = maxSearchChars - output.length;
          if (remaining <= 0) break;
          output += piece.slice(0, remaining);
          consumedUntil = window.end;
          if (output.length >= maxSearchChars) break;
        }
        return output.replace(/\s+/gu, " ").trim();
      };
      const clean = (value: string | null | undefined, max = 220) => {
        const normalized = (value ?? "").replace(/\s+/g, " ").trim();
        return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
      };
      const headings = nodes.filter((node): node is HTMLElement => node instanceof HTMLElement
        && /^(H[1-6])$/u.test(node.tagName) || node instanceof HTMLElement && node.getAttribute("role") === "heading");
      const structuralSelector = "main,article,section,table,ul,ol,form,nav,aside,footer,h1,h2,h3,h4,h5,h6,[role='main'],[role='article'],[role='region'],[role='navigation'],[role='contentinfo'],[role='complementary'],[role='list'],[role='form'],p,blockquote,pre,dl";
      const kindOf = (node: HTMLElement): BrowserRegionKind => {
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute("role");
        if (/^h[1-6]$/u.test(tag) || role === "heading") return "heading";
        if (tag === "article" || role === "article") return "article";
        if (tag === "table" || role === "table") return "table";
        if (tag === "ul" || tag === "ol" || role === "list") return "list";
        if (tag === "form" || role === "form") return "form";
        if (tag === "nav" || role === "navigation") return "navigation";
        if (tag === "footer" || role === "contentinfo") return "footer";
        if (tag === "aside" || role === "complementary") return "aside";
        if (tag === "main" || tag === "section" || role === "main" || role === "region") return "section";
        return "text";
      };
      const visible = (node: HTMLElement) => {
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const records: Array<{
        candidateIndex: number;
        ancestorIndexes: number[];
        kind: BrowserRegionKind;
        heading?: string;
        preview?: string;
        searchText: string;
        tableHeaders?: string[];
        formLabels?: string[];
        rowCount?: number;
        columnCount?: number;
        domOrder: number;
      }> = [];
      let visibleCount = 0;
      let totalSearchChars = 0;
      const candidateIndexByElement = new Map<HTMLElement, number>();
      nodes.forEach((candidate, candidateIndex) => {
        if (candidate instanceof HTMLElement) candidateIndexByElement.set(candidate, candidateIndex);
      });
      const priority = (node: unknown) => {
        if (!(node instanceof HTMLElement)) return 99;
        const tag = node.tagName.toLowerCase();
        const role = node.getAttribute("role");
        if (tag === "table" || role === "table") return 0;
        if (tag === "main" || tag === "article" || tag === "section" || role === "main" || role === "article" || role === "region") return 1;
        if (/^h[1-6]$/u.test(tag) || role === "heading") return 2;
        if (tag === "ul" || tag === "ol" || role === "list" || tag === "form" || role === "form") return 3;
        if (tag === "nav" || role === "navigation" || tag === "footer" || role === "contentinfo" || tag === "aside" || role === "complementary") return 5;
        if (tag === "div") return 6;
        return 4;
      };
      const candidateIndexes = Array.from({ length: nodes.length }, (_, index) => index)
        .sort((left, right) => priority(nodes[left]) - priority(nodes[right]) || left - right);
      let truncated = false;
      for (const index of candidateIndexes) {
        if (records.length >= regionLimit) {
          truncated = true;
          break;
        }
        const node = nodes[index];
        if (!(node instanceof HTMLElement) || !visible(node)) continue;
        const tag = node.tagName.toLowerCase();
        const text = node.innerText.replace(/\s+/g, " ").trim();
        if (tag === "div") {
          if (text.length < 120 || node.querySelector(structuralSelector)) continue;
          const childDivHasText = Array.from(node.querySelectorAll("div")).some(child => child.innerText.trim().length >= 120);
          if (childDivHasText) continue;
        }
        if (text.length === 0) continue;
        const kind = kindOf(node);
        let headingNode: HTMLElement | undefined;
        if (kind === "heading") headingNode = node;
        else headingNode = Array.from(node.querySelectorAll("h1,h2,h3,h4,h5,h6,[role='heading']"))
          .find((candidate): candidate is HTMLElement => candidate instanceof HTMLElement);
        if (!headingNode) {
          const regionContainer = node.closest("section,article,main,[role='main'],[role='region']");
          for (const candidate of headings) {
            if (!(candidate instanceof HTMLElement)) continue;
            const followsNode = Boolean(candidate.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING);
            if (!followsNode) continue;
            const headingContainer = candidate.closest("section,article,main,[role='main'],[role='region']");
            if (headingContainer === regionContainer || headingContainer?.contains(node)) headingNode = candidate;
          }
        }
        const heading = clean(headingNode?.innerText, 160);
        const rows = kind === "table" ? Array.from(node.querySelectorAll("tr")) : [];
        const headerRow = rows.find(row => row.querySelector("th")) ?? rows[0];
        const tableHeaders = kind === "table" && headerRow
          ? Array.from(headerRow.querySelectorAll("th,td")).map(cell => clean(cell.textContent, 120))
          : undefined;
        const formLabels = kind === "form"
          ? Array.from(node.querySelectorAll("input,textarea,select,button,[role='textbox'],[role='combobox']"))
            .flatMap(control => {
              const names: string[] = [];
              const ariaLabel = control.getAttribute("aria-label");
              if (ariaLabel) names.push(ariaLabel);
              const labelledBy = control.getAttribute("aria-labelledby")?.split(/\s+/u) ?? [];
              for (const id of labelledBy) {
                const label = document.getElementById(id)?.textContent;
                if (label) names.push(label);
              }
              const nativeLabels = (control as HTMLInputElement).labels;
              if (nativeLabels) {
                for (const label of Array.from(nativeLabels)) names.push(label.innerText);
              }
              return names;
            })
            .map(label => clean(label, 120))
            .filter(Boolean)
            .slice(0, 80)
          : undefined;
        const dataRows = rows.filter(row => row !== headerRow && row.querySelector("th,td"));
        const columnCount = Math.max(0, ...rows.map(row => row.querySelectorAll("th,td").length));
        const previewSource = kind === "table" && tableHeaders
          ? `${tableHeaders.join(" ")} ${dataRows[0]?.innerText ?? ""}`
          : text;
        const preview = clean(previewSource, 180);
        const ancestorIndexes: number[] = [];
        for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
          const ancestorIndex = candidateIndexByElement.get(ancestor);
          if (ancestorIndex !== undefined) ancestorIndexes.push(ancestorIndex);
        }
        let searchText = excerpt(text);
        if (totalSearchChars + searchText.length > totalSearchCharsLimit) {
          searchText = searchText.slice(0, Math.max(0, totalSearchCharsLimit - totalSearchChars));
          truncated = true;
        }
        totalSearchChars += searchText.length;
        visibleCount += 1;
        records.push({
          candidateIndex: index,
          ancestorIndexes,
          kind,
          ...(heading ? { heading } : {}),
          ...(preview ? { preview } : {}),
          searchText,
          ...(tableHeaders ? { tableHeaders } : {}),
          ...(formLabels && formLabels.length > 0 ? { formLabels } : {}),
          ...(kind === "table" ? { rowCount: dataRows.length, columnCount } : {}),
          domOrder: index,
        });
      }
      return { records, regionCount: visibleCount, truncated: truncated || nodes.length > regionLimit };
    }, {
      includeText,
      query,
      limit: MAX_INDEXED_REGIONS,
      maxSearchChars: MAX_SEARCH_REGION_CHARS,
      totalSearchCharsLimit: MAX_SEARCH_INDEX_CHARS,
    });
    const records: PageRegionRecord[] = result.records.map(record => ({
      ref: `r${revision}-${record.candidateIndex + 1}`,
      kind: record.kind,
      ...(record.heading ? { heading: record.heading } : {}),
      ...(record.preview ? { preview: record.preview } : {}),
      ...(record.rowCount === undefined ? {} : { rowCount: record.rowCount }),
      ...(record.columnCount === undefined ? {} : { columnCount: record.columnCount }),
      searchText: record.searchText,
      ...(record.tableHeaders ? { tableHeaders: record.tableHeaders } : {}),
      ...(record.formLabels ? { formLabels: record.formLabels } : {}),
      domOrder: record.domOrder,
      candidateIndex: record.candidateIndex,
      ...(record.ancestorIndexes.length > 0
        ? { ancestorRefs: record.ancestorIndexes.map(index => `r${revision}-${index + 1}`) }
        : {}),
    }));
    const normalized = { records, regionCount: result.regionCount, truncated: result.truncated };
    if (includeText) this.searchCache = { revision, query, ...normalized };
    else this.outlineCache = { revision, ...normalized };
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
