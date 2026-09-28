import type {
  BrowserContentBlock,
  BrowserPageType,
} from "../../../packages/shared/src/types";

export interface SemanticExtractionResult {
  blocks: Array<Omit<BrowserContentBlock, "ref">>;
  pageType: BrowserPageType;
  sourceTruncated: boolean;
}

/** This callback is serialized by Playwright; keep all runtime helpers local. */
export function extractSemanticBrowserBlocks(
  nodes: readonly unknown[],
  rawOptions?: unknown,
): SemanticExtractionResult {
  const options = typeof rawOptions === "object" && rawOptions !== null
    ? rawOptions as { frameUrl?: string; frameName?: string; readability?: boolean; pageUrl?: string }
    : {};
  const body = nodes[0];
  if (!(body instanceof HTMLElement)) return { blocks: [], pageType: "generic", sourceTruncated: false };

  const maxBlocks = 1_000;
  const maxChars = 2_000_000;
  let usedChars = 0;
  let sourceTruncated = false;
  let currentBlockTruncated = false;
  const blocks: Array<Omit<BrowserContentBlock, "ref">> = [];
  const all: HTMLElement[] = [];
  const visit = (node: Node): void => {
    if (node instanceof HTMLElement) {
      all.push(node);
      if (node.shadowRoot) visit(node.shadowRoot);
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  visit(body);

  const clean = (value: string, preserveLines = false): string => {
    const normalized = value
      .replace(/\u00a0/gu, " ")
      .replace(/\r\n?/gu, "\n")
      .split("\n")
      .map(line => line.replace(/[\t ]+/gu, " ").trim())
      .filter(Boolean)
      .join(preserveLines ? "\n" : " ")
      .trim();
    return normalized;
  };
  const bounded = (value: string, maxChars: number): string => {
    if (value.length > maxChars) currentBlockTruncated = true;
    return value.slice(0, maxChars);
  };
  const visible = (element: HTMLElement): boolean => {
    if (element.hidden || element.getAttribute("aria-hidden")?.toLowerCase() === "true") return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none"
      && style.visibility !== "hidden"
      && style.visibility !== "collapse"
      && style.contentVisibility !== "hidden";
  };
  const textOf = (element: HTMLElement, preserveLines = false): string => clean(
    preserveLines ? element.innerText || element.textContent || "" : element.innerText || element.textContent || "",
    preserveLines,
  );
  const roleOf = (element: HTMLElement): string | undefined => element.getAttribute("role")?.trim() || undefined;
  const tagIs = (element: HTMLElement, ...tags: string[]): boolean => tags.includes(element.tagName);
  const parentElements = (element: HTMLElement): HTMLElement[] => {
    const parents: HTMLElement[] = [];
    let parent: Node | null = element;
    while (parent) {
      if (parent instanceof HTMLElement) parents.push(parent);
      parent = parent.parentNode ?? (parent instanceof ShadowRoot ? parent.host : null);
    }
    return parents;
  };
  const headingNodes = all.filter(element => visible(element)
    && (/^H[1-6]$/u.test(element.tagName) || roleOf(element) === "heading"));
  const headingLevel = (element: HTMLElement): number => {
    const explicit = Number(element.getAttribute("aria-level"));
    if (Number.isFinite(explicit) && explicit > 0) return Math.min(6, explicit);
    return /^H[1-6]$/u.test(element.tagName) ? Number(element.tagName.slice(1)) : 2;
  };
  const headingPath = (element: HTMLElement): string[] => {
    const stack: Array<{ level: number; text: string }> = [];
    for (const heading of headingNodes) {
      if (heading !== element && !(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      const value = textOf(heading).slice(0, 300);
      if (!value) continue;
      const level = headingLevel(heading);
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, text: value });
      if (heading === element) break;
    }
    return stack.map(item => item.text);
  };
  const frameSource = {
    ...(options.frameUrl ? { frameUrl: options.frameUrl } : {}),
    ...(options.frameName ? { frameName: options.frameName } : {}),
  };
  const add = (block: Omit<BrowserContentBlock, "ref">): void => {
    if (blocks.length >= maxBlocks) {
      sourceTruncated = true;
      return;
    }
    const size = JSON.stringify(block).length;
    if (usedChars + size > maxChars) {
      sourceTruncated = true;
      return;
    }
    usedChars += size;
    blocks.push(block);
  };
  const addElement = (
    element: HTMLElement,
    type: BrowserContentBlock["type"],
    importance: number,
    extra: Partial<BrowserContentBlock> = {},
  ): void => {
    const path = headingPath(element);
    const ownHeading = type === "heading" ? textOf(element).slice(0, 300) : undefined;
    const headingPathValue = ownHeading && path[path.length - 1] !== ownHeading ? [...path, ownHeading] : path;
    const heading = headingPathValue[headingPathValue.length - 1];
    add({
      type,
      ...(heading ? { heading } : {}),
      ...(headingPathValue.length > 0 ? { headingPath: headingPathValue } : {}),
      source: { ...frameSource, extractor: "dom" },
      importance,
      boilerplate: false,
      ...extra,
    });
  };
  const chromeRole = (element: HTMLElement): string | undefined => {
    const role = roleOf(element);
    if (element.tagName === "NAV" || role === "navigation") return "navigation";
    if (role === "banner") return "banner";
    if (element.tagName === "FOOTER" || role === "contentinfo") return "contentinfo";
    if (element.tagName === "ASIDE" || role === "complementary") return "complementary";
    if (element.tagName === "HEADER" && !parentElements(element).some(parent => parent !== element
      && (parent.tagName === "MAIN" || parent.tagName === "ARTICLE" || ["main", "article"].includes(roleOf(parent) ?? "")))) return "banner";
    return undefined;
  };
  const chromeRoots = all.filter(element => visible(element) && chromeRole(element));
  const chromeFor = (element: HTMLElement): HTMLElement | undefined => parentElements(element)
    .find(parent => chromeRoots.includes(parent));
  const withinTable = (element: HTMLElement): boolean => parentElements(element).some(parent => (
    parent !== element && (parent.tagName === "TABLE" || ["table", "grid", "treegrid"].includes(roleOf(parent) ?? ""))
  ));
  const withinList = (element: HTMLElement): boolean => parentElements(element).some(parent => (
    parent !== element && (tagIs(parent, "UL", "OL") || roleOf(parent) === "list")
  ));
  const linksOf = (element: HTMLElement, limit = 30): Array<{ text: string; href: string }> => {
    const found: Array<{ text: string; href: string }> = [];
    for (const link of Array.from(element.querySelectorAll("a[href]"))) {
      if (!(link instanceof HTMLAnchorElement) || !visible(link)) continue;
      let href: string;
      try {
        const target = new URL(link.href);
        if (!["http:", "https:"].includes(target.protocol)) continue;
        // Keep the resolved href Playwright observed on the anchor. In
        // particular, DuckDuckGo redirect URLs are not silently replaced by
        // their `uddg` payload; navigation must retain the source page's
        // actual link provenance.
        href = target.href;
      } catch {
        continue;
      }
      const text = textOf(link).slice(0, 240) || clean(link.getAttribute("aria-label") ?? "").slice(0, 240);
      if (!text && !href) continue;
      found.push({ text, href });
      if (found.length >= limit) break;
    }
    return found;
  };
  const tableRows = (table: HTMLElement): {
    columns: string[];
    rows: string[][];
    cellSpans: Array<Array<{ rowspan: number; colspan: number }>>;
    rowCount: number;
    columnCount: number;
  } => {
    const isAria = !tagIs(table, "TABLE");
    const nearestTable = (element: HTMLElement): HTMLElement | undefined => parentElements(element)
      .find(parent => parent !== element && (parent.tagName === "TABLE"
        || ["table", "grid", "treegrid"].includes(roleOf(parent) ?? "")));
    const rowElements = all.filter(candidate => {
      if (!visible(candidate)) return false;
      if (isAria) return roleOf(candidate) === "row" && nearestTable(candidate) === table;
      return candidate.tagName === "TR" && candidate.closest("table") === table;
    });
    const cellsFor = (row: HTMLElement): HTMLElement[] => all.filter(candidate => {
      if (!visible(candidate)) return false;
      const belongs = parentElements(candidate).includes(row);
      if (!belongs) return false;
      return isAria
        ? ["columnheader", "rowheader", "cell", "gridcell"].includes(roleOf(candidate) ?? "")
        : ["TH", "TD"].includes(candidate.tagName) && candidate.closest("tr") === row;
    }).filter(candidate => {
      const rowAbove = parentElements(candidate).find(parent => roleOf(parent) === "row" || parent.tagName === "TR");
      return rowAbove === row;
    });
    const sourceRows = rowElements.map(row => ({
      row,
      cells: cellsFor(row).map(cell => ({
        cell,
        text: bounded(textOf(cell), 2_000),
        rowspan: Math.max(1, Math.min(100, Number(cell.getAttribute("rowspan")) || 1)),
        colspan: Math.max(1, Math.min(100, Number(cell.getAttribute("colspan")) || 1)),
        header: isAria ? roleOf(cell) === "columnheader" : cell.tagName === "TH",
      })),
    }));
    const theadRows = sourceRows.filter(({ row }) => !isAria && Boolean(row.closest("thead")));
    const headerRows = theadRows.length > 0
      ? theadRows
      : sourceRows.length === 0
        ? []
        : sourceRows[0]!.cells.some(item => item.header)
          ? sourceRows.slice(0, Math.max(1, sourceRows.findIndex(({ cells }) => cells.some(item => !item.header)) < 0
            ? sourceRows.length
            : sourceRows.findIndex(({ cells }) => cells.some(item => !item.header))))
          : sourceRows.slice(0, 1);
    const headerIndices = new Set(headerRows.map(item => item.row));
    const grid: string[][] = Array.from({ length: sourceRows.length }, () => []);
    const spans: Array<Array<{ rowspan: number; colspan: number }>> = sourceRows.map(() => []);
    sourceRows.forEach(({ cells }, rowIndex) => {
      let column = 0;
      for (const item of cells) {
        while (grid[rowIndex]?.[column] !== undefined) column += 1;
        const rowEnd = Math.min(sourceRows.length, rowIndex + item.rowspan);
        for (let r = rowIndex; r < rowEnd; r += 1) {
          for (let c = 0; c < item.colspan; c += 1) {
            grid[r]![column + c] = item.text;
          }
        }
        spans[rowIndex]!.push({ rowspan: item.rowspan, colspan: item.colspan });
        column += item.colspan;
      }
    });
    const columnCount = Math.max(0, ...grid.map(row => row.length));
    const columns = Array.from({ length: columnCount }, (_, columnIndex) => {
      const labels = headerRows.map(({ row }) => {
        const sourceIndex = sourceRows.findIndex(item => item.row === row);
        return grid[sourceIndex]?.[columnIndex] ?? "";
      }).filter(Boolean);
      const unique = [...new Set(labels)];
      return unique.join(": ") || `Column ${columnIndex + 1}`;
    });
    const dataRows = sourceRows.flatMap((sourceRow, index) => {
      if (headerIndices.has(sourceRow.row)) return [];
      const values = grid[index] ?? [];
      if (values.every(value => !value)) return [];
      return [Array.from({ length: columnCount }, (_, columnIndex) => values[columnIndex] ?? "")];
    });
    return { columns, rows: dataRows, cellSpans: spans, rowCount: dataRows.length, columnCount };
  };
  const tableCaption = (table: HTMLElement): string => {
    const labelledBy = clean((table.getAttribute("aria-labelledby") ?? "").split(/\s+/u)
      .map(id => document.getElementById(id))
      .filter((item): item is HTMLElement => item instanceof HTMLElement && visible(item))
      .map(item => textOf(item)).join(" "));
    const captionElement = Array.from(table.children).find(child => child instanceof HTMLElement && child.tagName === "CAPTION");
    const caption = captionElement instanceof HTMLElement ? textOf(captionElement) : "";
    return (labelledBy || clean(table.getAttribute("aria-label") ?? "") || caption).slice(0, 300);
  };

  // Page chrome is retained as a low-importance artifact, but its descendants
  // are not independently indexed as article/table/list content.
  for (const root of chromeRoots) {
    if (chromeFor(root) && chromeFor(root) !== root) continue;
    const role = chromeRole(root) ?? "navigation";
    const text = textOf(root).slice(0, 20_000);
    if (!text) continue;
    add({
      type: "navigation",
      role,
      text,
      links: linksOf(root),
      source: { ...frameSource, extractor: "dom" },
      importance: 0.1,
      boilerplate: true,
    });
  }

  const visibleContent = all.filter(element => visible(element) && !chromeFor(element));
  const seenTables = new Set<HTMLElement>();
  for (const element of visibleContent) {
    if (chromeFor(element)) continue;
    const role = roleOf(element);
    if (/^H[1-6]$/u.test(element.tagName) || role === "heading") {
      const text = textOf(element).slice(0, 2_000);
      if (text) addElement(element, "heading", headingLevel(element) === 1 ? 0.9 : 0.65, {
        text,
        role: role ?? element.tagName.toLowerCase(),
      });
      continue;
    }
    if (tagIs(element, "TABLE") || ["table", "grid", "treegrid"].includes(role ?? "")) {
      if (withinTable(element) || seenTables.has(element)) continue;
      seenTables.add(element);
      currentBlockTruncated = false;
      const data = tableRows(element);
      if (data.columnCount === 0 && data.rowCount === 0) continue;
      const caption = tableCaption(element);
      addElement(element, "table", 0.98, {
        ...(caption ? { caption } : {}),
        ...data,
        ...(currentBlockTruncated ? { truncated: true } : {}),
        role: role ?? "table",
      });
      continue;
    }
    if (tagIs(element, "UL", "OL") || role === "list") {
      if (withinList(element)) continue;
      const itemElements = Array.from(element.querySelectorAll("li,[role='listitem']"))
        .filter(item => item instanceof HTMLElement && visible(item)
          && parentElements(item).find(parent => parent !== item
            && (tagIs(parent, "UL", "OL") || roleOf(parent) === "list")) === element);
      const items = itemElements.map(item => textOf(item as HTMLElement)).filter(Boolean);
      if (items.length > 0) addElement(element, "list", 0.72, {
        ordered: element.tagName === "OL",
        items,
        rowCount: items.length,
        role: role ?? "list",
      });
      continue;
    }
    if (element.tagName === "DL") {
      const definitions: Array<{ term: string; definition: string }> = [];
      let terms: string[] = [];
      for (const child of Array.from(element.children)) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.tagName === "DT") terms.push(textOf(child));
        else if (child.tagName === "DD") {
          const definition = textOf(child);
          for (const term of terms) definitions.push({ term, definition });
          terms = [];
        }
      }
      if (definitions.length > 0) addElement(element, "definition", 0.7, { definitions, role: role ?? "definition" });
      continue;
    }
    if (tagIs(element, "PRE") || (element.tagName === "CODE" && !parentElements(element).some(parent => parent !== element && parent.tagName === "PRE"))) {
      currentBlockTruncated = false;
      const code = bounded(textOf(element, true), 100_000);
      const language = clean(element.getAttribute("data-language") ?? element.getAttribute("lang") ?? "").slice(0, 40);
      if (code) addElement(element, "code", 0.82, {
        text: code,
        ...(language ? { language } : {}),
        role: role ?? element.tagName.toLowerCase(),
        ...(currentBlockTruncated ? { truncated: true } : {}),
      });
      continue;
    }
    if (element.tagName === "FORM" || role === "form") {
      currentBlockTruncated = false;
      const controls = Array.from(element.querySelectorAll("input,textarea,select,button,[role='textbox'],[role='combobox'],[role='checkbox'],[role='radio']"));
      const fields = controls.flatMap(control => {
        if (!(control instanceof HTMLElement) || !visible(control)) return [];
        const labelled = control.getAttribute("aria-label")
          ?? (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
            ? control.labels?.[0]?.innerText
            : undefined)
          ?? control.getAttribute("placeholder")
          ?? control.getAttribute("name")
          ?? control.getAttribute("title")
          ?? "";
        const type = control instanceof HTMLInputElement ? control.type : control.tagName.toLowerCase();
        const value = control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement || control instanceof HTMLSelectElement
          ? control.value
          : bounded(textOf(control), 200);
        return [{
          label: clean(labelled).slice(0, 240),
          ...(type ? { type } : {}),
          ...(value ? { value: clean(value).slice(0, 300) } : {}),
          ...(control.hasAttribute("required") || control.getAttribute("aria-required") === "true" ? { required: true } : {}),
        }];
      });
      if (fields.length > 0) addElement(element, "form", 0.92, {
        fields,
        role: role ?? "form",
        ...(currentBlockTruncated ? { truncated: true } : {}),
      });
      continue;
    }
    if (tagIs(element, "P", "BLOCKQUOTE")) {
      if (withinTable(element) || withinList(element)) continue;
      currentBlockTruncated = false;
      const text = bounded(textOf(element, true), 10_000);
      if (text) addElement(element, "text", element.tagName === "BLOCKQUOTE" ? 0.72 : 0.68, {
        text,
        role: role ?? element.tagName.toLowerCase(),
        ...(currentBlockTruncated ? { truncated: true } : {}),
      });
      continue;
    }
  }

  // Generic div-heavy applications often expose useful text without semantic
  // tags. Select leaf-like, text-dense containers instead of every div.
  const divCandidates = visibleContent.filter(element => element.tagName === "DIV" && !withinTable(element) && !withinList(element));
  const genericBlocks = divCandidates.flatMap(element => {
    const text = textOf(element, true);
    if (text.length < 80 || text.length > 20_000) return [];
    const hasSemanticChildren = Array.from(element.querySelectorAll("p,blockquote,pre,table,ul,ol,dl,form,[role='table'],[role='grid'],[role='list'],[role='form']"))
      .some(child => child instanceof HTMLElement && visible(child));
    const hasContentDivChild = Array.from(element.children).some(child => child instanceof HTMLElement
      && child.tagName === "DIV" && textOf(child).length >= 80);
    if (hasSemanticChildren || hasContentDivChild) return [];
    const anchors = Array.from(element.querySelectorAll("a[href]")).reduce((sum, anchor) => (
      sum + (anchor instanceof HTMLElement ? textOf(anchor).length : 0)
    ), 0);
    const density = text.length / Math.max(1, element.querySelectorAll("*").length);
    if (anchors / text.length > 0.35 || density < 2) return [];
    return [{ element, text }];
  });
  for (const candidate of genericBlocks) {
    currentBlockTruncated = false;
    addElement(candidate.element, "other", 0.52, {
      text: bounded(candidate.text, 20_000),
      links: linksOf(candidate.element),
      role: roleOf(candidate.element) ?? "region",
      ...(currentBlockTruncated ? { truncated: true } : {}),
    });
  }

  // Search result records are constructed only from observed anchors and
  // credible result structures. Ordinary list navigation is never enough to
  // turn a page into a search-results page.
  const parsedPageUrl = (() => {
    try { return new URL(options.pageUrl ?? location.href); } catch { return undefined; }
  })();
  const isDuckDuckGoQuery = (parsedPageUrl?.hostname === "duckduckgo.com"
    || parsedPageUrl?.hostname.endsWith(".duckduckgo.com") === true)
    && Boolean((parsedPageUrl.searchParams.get("q") ?? parsedPageUrl.searchParams.get("query"))?.trim());
  const hasSearchControl = all.some(element => {
    if (roleOf(element) === "search") return true;
    if (element.tagName === "INPUT") {
      const input = element as HTMLInputElement;
      return input.type === "search" || /^(?:q|query|search)$/iu.test(input.name);
    }
    if (element.tagName !== "FORM") return false;
    return Boolean(element.querySelector("input[type='search'],input[name='q'],input[name='query'],input[name='search']"));
  });
  const hasResultMarker = (element: HTMLElement): boolean => {
    const values = [
      element.id,
      typeof element.className === "string" ? element.className : "",
      element.getAttribute("data-testid") ?? "",
      element.getAttribute("data-test") ?? "",
      element.getAttribute("role") ?? "",
    ];
    return values.some(value => /(?:^|[\s_-])(?:search[-_])?result(?:s)?(?:[\s_-]|$)/iu.test(value));
  };
  const searchResultCandidates = new Map<string, { title: string; href: string; snippet: string; element: HTMLElement }>();
  for (const anchor of all) {
    if (!(anchor instanceof HTMLAnchorElement) || !visible(anchor) || !anchor.href || chromeFor(anchor)) continue;
    let parsedHref: URL;
    try { parsedHref = new URL(anchor.href); } catch { continue; }
    if (!["http:", "https:"].includes(parsedHref.protocol)) continue;
    const ancestors = parentElements(anchor).filter(parent => parent !== anchor);
    const container = ancestors.find(hasResultMarker);
    if (!container) continue;
    const title = textOf(anchor).slice(0, 400);
    if (title.length < 4) continue;
    let snippet = Array.from(container.querySelectorAll("p,[class*='snippet' i],[data-testid*='snippet' i]"))
      .filter(item => item instanceof HTMLElement && visible(item))
      .map(item => textOf(item as HTMLElement))
      .filter(Boolean)
      .join(" ")
      .slice(0, 800);
    if (!snippet) snippet = textOf(container).replace(title, " ").slice(0, 800);
    searchResultCandidates.set(parsedHref.href, { title, href: parsedHref.href, snippet, element: container });
  }
  const isSearchPage = isDuckDuckGoQuery
    ? searchResultCandidates.size > 0
    : hasSearchControl && searchResultCandidates.size >= 3;
  if (isSearchPage) {
    for (const result of searchResultCandidates.values()) {
      addElement(result.element, "search_result", 0.96, {
        title: result.title,
        href: result.href,
        snippet: result.snippet,
        text: [result.title, result.snippet].filter(Boolean).join("\n"),
        role: "search-result",
      });
    }
  }

  const tableBlocks = blocks.filter(block => block.type === "table");
  const formCount = blocks.filter(block => block.type === "form").length;
  const codeCount = blocks.filter(block => block.type === "code").length;
  const proseBlocks = blocks.filter(block => block.type === "text" && !block.boilerplate);
  const proseChars = proseBlocks.reduce((sum, block) => sum + (block.text?.length ?? 0), 0);
  const articleLike = all.some(element => element.tagName === "ARTICLE" || element.hasAttribute("itemprop")
    && element.getAttribute("itemprop") === "articleBody");
  let pageType: BrowserPageType;
  if (isSearchPage) pageType = "search_results";
  else if (tableBlocks.some(block => (block.rowCount ?? 0) > 0 && (block.columnCount ?? 0) > 1)) pageType = "data_table";
  else if (formCount > 0 && proseChars < 1_200) pageType = "form";
  else if (codeCount > 0 && proseChars > 0) pageType = "documentation";
  else if (articleLike || proseChars >= 700) pageType = "article";
  else if (formCount > 0 || tableBlocks.length > 0 || all.some(element => ["application", "main", "grid", "treegrid"].includes(roleOf(element) ?? ""))) pageType = "application";
  else pageType = "generic";

  // Readability runs locally in the page only for prose-heavy candidates.
  // The semantic/table blocks remain authoritative for structured content.
  if ((pageType === "article" || pageType === "documentation") && options.readability) {
    try {
      const readerWindow = window as Window & {
        __helmReadability?: new (doc: Document, options?: Record<string, unknown>) => { parse(): { title?: string; byline?: string; textContent?: string; excerpt?: string } | null };
        __helmIsProbablyReaderable?: (doc: Document) => boolean;
      };
      const documentCopy = document.cloneNode(true) as Document;
      if (readerWindow.__helmReadability && (!readerWindow.__helmIsProbablyReaderable || readerWindow.__helmIsProbablyReaderable(documentCopy))) {
        const parsed = new readerWindow.__helmReadability(documentCopy, { keepClasses: false }).parse();
        const text = clean(parsed?.textContent ?? "", true);
        if (text.length >= 400) {
          const canonical = text.toLocaleLowerCase();
          for (let index = blocks.length - 1; index >= 0; index -= 1) {
            const block = blocks[index]!;
            if (block.type !== "text" || !block.text || block.text.length < 30 || block.boilerplate) continue;
            if (canonical.includes(clean(block.text).toLocaleLowerCase())) {
              usedChars = Math.max(0, usedChars - JSON.stringify(block).length);
              blocks.splice(index, 1);
            }
          }
          const title = clean(parsed?.title ?? "").slice(0, 300);
          add({
            type: "text",
            text,
            ...(title ? { heading: title, headingPath: [title] } : {}),
            source: { ...frameSource, extractor: "readability" },
            importance: 0.86,
            boilerplate: false,
            role: "article",
          });
        }
      }
    } catch {
      // Readability is an optional prose candidate; semantic DOM blocks remain.
    }
  }

  // If a page has only unstructured but visible body text, retain a single
  // fallback block. This is intentionally the last-resort representation.
  const hasUseful = blocks.some(block => !block.boilerplate && Boolean(
    block.text?.trim() || block.rows?.length || block.items?.length || block.fields?.length || block.definitions?.length,
  ));
  if (!hasUseful) {
    currentBlockTruncated = false;
    const fallback = bounded(textOf(body, true), 20_000);
    if (fallback) add({
      type: "text",
      text: fallback,
      source: { ...frameSource, extractor: "dom" },
      importance: 0.45,
      boilerplate: false,
      ...(currentBlockTruncated ? { truncated: true } : {}),
    });
  }

  return { blocks, pageType, sourceTruncated };
}

export function extractAccessibleCandidate(snapshot: unknown): string {
  const pieces: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const node = value as Record<string, unknown>;
    if (typeof node.text === "string") pieces.push(node.text);
    else if (typeof node.name === "string") pieces.push(node.name);
    if (Array.isArray(node.children)) visit(node.children);
  };
  visit(snapshot);
  return [...new Set(pieces.map(piece => piece.replace(/\s+/gu, " ").trim()).filter(Boolean))].join("\n").slice(0, 80_000);
}
