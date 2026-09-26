import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GuestRpcError } from '../src/errors';
import { BrowserController } from '../src/browser';
import { GuestRuntime } from '../src/runtime';
import { GuestSandbox } from '../src/sandbox';
import { extractAccessibleCandidate } from '../src/semantic-extraction';

describe('progressive browser perception', () => {
  it('keeps snapshots bounded, finds late tables, extracts relevant passages, and rejects stale refs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-perception-'));
    const workspace = join(root, 'workspace');
    const sandbox = new GuestSandbox({ root, workspace });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const navigation = Array.from({ length: 1_500 }, (_, index) => (
      `<div><a href="#nav-${index}">Navigation item ${index}</a></div>`
    )).join('');
    const unrelated = Array.from({ length: 180 }, (_, index) => (
      `<p>Unrelated article paragraph ${index} discusses gardening and local events.</p>`
    )).join('');
    const filler = Array.from({ length: 900 }, (_, index) => (
      `Earlier body passage ${index} contains unrelated public information. `
    )).join('');
    const largeRows = Array.from({ length: 240 }, (_, index) => (
      `<tr><td>Item-${index}</td><td>Code-${index}</td><td>Description ${index}</td></tr>`
    )).join('');
    const html = `<!doctype html><html><head><title>Large synthetic page</title></head><body>
      <button type="button" onclick="document.querySelector('#dynamic').textContent = 'Updated dynamic text'">Update dynamic text</button>
      <nav>${navigation}</nav>
      <article><h1>Community updates</h1>${unrelated}</article>
      <main><h2>Reference data</h2><p>${filler}</p>
        <section><div><div><p>Distinctive lower-page passage: Kestrel-482 exchange review marker.</p>
          <table id="rates"><thead><tr><th>Currency</th><th>Unit</th><th>Buying</th><th>Selling</th></tr></thead>
            <tbody><tr><td>USD</td><td>1</td><td>132.10</td><td>132.70</td></tr>
            <tr><td>EUR</td><td>1</td><td>143.20</td><td>144.00</td></tr></tbody></table>
          <table id="large"><thead><tr><th>Item</th><th>Code</th><th>Description</th></tr></thead>
            <tbody>${largeRows}</tbody></table>
        </div></div></section>
        <form><label for="email">Email address</label><input id="email" type="email">
          <label for="verification">Verification code</label><input id="verification"></form>
      </main>
      <div id="dynamic">Initial dynamic text</div>
      <footer>${'<p>Unrelated footer content for bounded extraction.</p>'.repeat(80)}</footer>
    </body></html>`;
    const portfolioHtml = `<!doctype html><html><head><title>Kunjan Dhungana</title></head><body>
      <nav>Home About Navigation boilerplate</nav>
      <main><h1>Kunjan Dhungana</h1><p>Self-taught software engineer from Nepal and co-founder of Neplex.</p>
        <section><h2>Work</h2><p>I am particularly interested in runtimes and developer experience. ${'I build tools for developers. '.repeat(18)}</p></section>
        <section><h2>Outside software</h2><p>I am slowly learning piano and enjoying the practice.</p></section>
        <section><h2>Work with me</h2><p>Book a call to discuss developer tooling. Portfolio region complete-read marker: PIANO-REGION-9284.</p></section>
      </main>
      <footer>Footer boilerplate that should be excluded.</footer>
    </body></html>`;
    const bodyFallbackHtml = `<!doctype html><html><head><title>Body fallback</title><style>.hidden{display:none}</style></head><body>
      <nav>Navigation fallback noise</nav><p>${'Visible body content. '.repeat(20)}BODY-FALLBACK-END</p>
      <p aria-hidden="true">ARIA-HIDDEN-SECRET</p><div hidden>HIDDEN-SECRET</div>
      <script>throw new Error('SCRIPT-SECRET')</script><noscript>NOSCRIPT-SECRET</noscript><svg><text>SVG-SECRET</text></svg>
    </body></html>`;
    const largeReadHtml = `<!doctype html><html><head><title>Large read</title></head><body><main>
      <h1>Large readable document</h1>${Array.from({ length: 120 }, (_, index) => `<section><h2>Chapter ${index}</h2><p>${`Chapter ${index} paragraph with bounded continuation content. `.repeat(14)}</p></section>`).join('')}
    </main></body></html>`;
    const pagePath = await sandbox.write('workspace/large.html', html);
    const nextPath = await sandbox.write('workspace/next.html', '<!doctype html><title>Next page</title><main><h1>Next</h1></main>');
    const portfolioPath = await sandbox.write('workspace/portfolio.html', portfolioHtml);
    const bodyFallbackPath = await sandbox.write('workspace/body-fallback.html', bodyFallbackHtml);
    const largeReadPath = await sandbox.write('workspace/large-read.html', largeReadHtml);

    try {
      await controller.navigate({ url: pathToFileURL(pagePath.path).href });
      const snapshot = await controller.snapshot();
      const elementRef = snapshot.elements.find(element => element.role === 'link')?.ref;
      const updateRef = snapshot.elements.find(element => element.name.includes('Update dynamic text'))?.ref;
      expect(updateRef).toBeDefined();
      expect(snapshot.outline.length).toBeLessThanOrEqual(60);
      expect(snapshot.elements.length).toBeLessThanOrEqual(80);
      expect(JSON.stringify(snapshot)).not.toContain('Unrelated article paragraph 179');
      expect(JSON.stringify(snapshot).length).toBeLessThan(30_000);

      const search = await controller.search({ query: 'foreign exchange currency buying selling rates', maxResults: 5 });
      expect(search.results[0]).toMatchObject({ kind: 'table', rowCount: 2, columnCount: 4 });
      expect(search).toMatchObject({ operation: 'search', searchCompleted: true, pageReadable: true });
      expect(search.matchCount).toBe(search.results.length);
      expect(search.matchCount).toBeGreaterThan(0);
      expect(search.results.length).toBeLessThanOrEqual(5);
      expect(JSON.stringify(search).length).toBeLessThan(12_000);
      const noMatchSearch = await controller.search({ query: 'qzxwvv-9347182-uniquetoken' });
      expect(noMatchSearch).toMatchObject({
        operation: 'search', searchCompleted: true, matchCount: 0, pageReadable: true,
        message: 'Search completed successfully. No page text matched the query.',
      });
      const nestedSearch = await controller.search({ query: 'currency buying selling rates', maxResults: 10 });
      expect(nestedSearch.results.filter(result => ['section', 'table', 'text'].includes(result.kind))).toHaveLength(1);
      const tableRef = search.results[0]!.ref;
      const inspected = await controller.inspectRegion({ ref: tableRef });
      expect(inspected).toMatchObject({
        kind: 'table',
        format: 'table',
        columns: ['Currency', 'Unit', 'Buying', 'Selling'],
        rows: [
          ['USD', '1', '132.10', '132.70'],
          ['EUR', '1', '143.20', '144.00'],
        ],
        rowCount: 2,
        returnedRowCount: 2,
        offset: 0,
        columnCount: 4,
      });
      expect(JSON.stringify(inspected).length).toBeLessThan(12_000);

      const formSearch = await controller.search({ query: 'email address verification code' });
      expect(formSearch.results[0]?.kind).toBe('form');
      expect(JSON.stringify(formSearch).length).toBeLessThan(12_000);

      const largeTableSearch = await controller.search({ query: 'catalog item code description' });
      const largeTableRef = largeTableSearch.results.find(result => result.kind === 'table')?.ref;
      expect(largeTableRef).toBeDefined();
      const tablePage = await controller.inspectRegion({ ref: largeTableRef!, format: 'table', offset: 100, limit: 10 });
      expect(tablePage).toMatchObject({
        format: 'table',
        rowCount: 240,
        returnedRowCount: 10,
        offset: 100,
        truncated: true,
      });
      expect(JSON.stringify(tablePage).length).toBeLessThan(12_000);
      if (tablePage.format === 'table') expect(tablePage.rows[0]?.[0]).toBe('Item-100');

      const relevantSearch = await controller.search({ query: 'Kestrel-482 exchange review marker' });
      const relevant = relevantSearch.results.map(result => result.snippet ?? '').join('\n');
      expect(relevant).toContain('Kestrel-482 exchange review marker');
      expect(relevant).not.toContain('Earlier body passage 0');
      expect(relevant.length).toBeLessThanOrEqual(5 * 800);

      await controller.click(updateRef!);
      const changed = await controller.getState();
      expect(changed.revision).toBeGreaterThan(snapshot.revision);
      await expect(controller.inspectRegion({ ref: tableRef })).rejects.toMatchObject({ code: 'STALE_REGION_REF' });
      if (elementRef) {
        await expect(controller.click(elementRef)).rejects.toMatchObject({ code: 'STALE_ELEMENT_REF' });
      }

      const beforeNavigation = await controller.snapshot();
      const staleRef = beforeNavigation.outline[0]?.ref;
      await controller.navigate({ url: pathToFileURL(nextPath.path).href });
      if (staleRef) {
        await expect(controller.inspectRegion({ ref: staleRef })).rejects.toMatchObject({ code: 'STALE_REGION_REF' });
      }

      await controller.navigate({ url: pathToFileURL(portfolioPath.path).href });
      const portfolio = await controller.read({ mode: 'readable', maxChars: 12_000 });
      const portfolioText = portfolio.sections.map(section => `${section.heading ?? ''}\n${section.text}`).join('\n');
      expect(portfolio).toMatchObject({ operation: 'read', readable: true, mode: 'readable', source: 'main', truncated: false });
      expect(portfolioText).toContain('Self-taught software engineer from Nepal');
      expect(portfolioText).toContain('Work');
      expect(portfolioText).toContain('Outside software');
      expect(portfolioText).toContain('Work with me');
      expect(portfolioText).not.toContain('Navigation boilerplate');
      expect(portfolioText).not.toContain('Footer boilerplate');

      const portfolioSnapshot = await controller.snapshot();
      const mainRef = portfolioSnapshot.outline.find(region => region.kind === 'section')?.ref;
      expect(mainRef).toBeDefined();
      const fullRegion = await controller.read({ ref: mainRef!, maxChars: 5_000 });
      expect(fullRegion.source).toBe('region');
      expect(fullRegion.sections.map(section => section.text).join('\n')).toContain('PIANO-REGION-9284');

      await controller.navigate({ url: pathToFileURL(bodyFallbackPath.path).href });
      const bodyFallback = await controller.read({ mode: 'readable', maxChars: 100 });
      const bodyFallbackText = bodyFallback.sections.map(section => section.text).join('\n');
      expect(bodyFallback).toMatchObject({ source: 'body', readable: true, truncated: true });
      expect(bodyFallback.returnedChars).toBeLessThanOrEqual(100);
      expect(bodyFallbackText).toContain('Visible body content');
      expect(bodyFallbackText).not.toContain('Navigation fallback noise');
      expect(bodyFallbackText).not.toContain('ARIA-HIDDEN-SECRET');
      expect(bodyFallbackText).not.toContain('HIDDEN-SECRET');
      expect(bodyFallbackText).not.toContain('SCRIPT-SECRET');
      expect(bodyFallbackText).not.toContain('NOSCRIPT-SECRET');
      expect(bodyFallbackText).not.toContain('SVG-SECRET');

      await controller.navigate({ url: pathToFileURL(largeReadPath.path).href });
      const firstChunk = await controller.read({ mode: 'readable', maxChars: 1_000 });
      expect(firstChunk.returnedChars).toBeLessThanOrEqual(1_000);
      expect(firstChunk.truncated).toBe(true);
      expect(firstChunk.nextCursor).toBeDefined();
      expect(JSON.stringify(firstChunk).length).toBeLessThan(2_500);
      const secondChunk = await controller.read({ mode: 'readable', maxChars: 1_000, cursor: firstChunk.nextCursor });
      expect(secondChunk.returnedChars).toBeGreaterThan(0);
      expect(secondChunk.sections.map(section => section.text).join('\n')).not.toBe(firstChunk.sections.map(section => section.text).join('\n'));
      expect(secondChunk.totalChars).toBeGreaterThan(10_000);
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('ranks semantic browser blocks, exports complete content refs, and expires refs with page revisions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-content-'));
    const workspace = join(root, 'workspace');
    const sandbox = new GuestSandbox({ root, workspace });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const runtime = new GuestRuntime({ sandbox, browser: controller });
    const fixture = async (name: string): Promise<string> => {
      const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
      return (await sandbox.write(`workspace/${name}`, html)).path;
    };

    try {
      const forexPath = await fixture('forex.html');
      await controller.navigate({ url: pathToFileURL(forexPath).href });
      const forex = await controller.read({ query: 'exchange rate data' });
      const table = forex.blocks?.find(block => block.type === 'table');
      expect(forex).toMatchObject({ pageType: 'data_table', query: 'exchange rate data' });
      expect(table).toMatchObject({
        type: 'table',
        headingPath: ['Foreign Exchange Rate', 'Exchange Rate of 24-September-2026 10:00 AM'],
        columns: [
          'Currency',
          'Code',
          'Unit',
          'Buying: Cash below Deno 50',
          'Buying: Cash 50 and above Deno',
          'Selling',
        ],
        rows: [
          ['USD', 'USD', '1', '152.28', '153.05', '153.65'],
          ['Euro', 'EUR', '1', '173.65', '173.65', '175.36'],
        ],
        rowCount: 4,
        columnCount: 6,
      });
      expect(forex.diagnostics?.tableCount).toBe(1);
      expect(forex.diagnostics?.selectedRefs[0]?.ref).toBe(table?.ref);

      const overview = await controller.read();
      expect(overview.blocks?.find(block => block.type === 'navigation')).toMatchObject({
        type: 'navigation',
        boilerplate: true,
        importance: 0.1,
      });
      const repeated = await controller.read({ query: 'currency buying selling' });
      expect(repeated.blocks?.[0]?.ref).toBe(table?.ref);
      const fullTable = await controller.read({ ref: table!.ref, limit: 20 });
      expect(fullTable.blocks?.[0]?.rows).toEqual([
        ['USD', 'USD', '1', '152.28', '153.05', '153.65'],
        ['Euro', 'EUR', '1', '173.65', '173.65', '175.36'],
        ['Japanese Yen', 'JPY', '10', '9.69', '9.69', '9.78'],
        ['Indian Currency', 'INR', '100', '160.00', '160.00', '160.15'],
      ]);
      expect(fullTable.blocks?.[0]?.cellSpans?.[0]).toEqual([
        { rowspan: 2, colspan: 1 },
        { rowspan: 2, colspan: 1 },
        { rowspan: 2, colspan: 1 },
        { rowspan: 1, colspan: 2 },
        { rowspan: 2, colspan: 1 },
      ]);

      const write = await runtime.dispatch({
        id: 'forex-source-ref-write',
        method: 'fs.write',
        params: { path: 'workspace/forex.txt', sourceRef: table!.ref, format: 'text' },
      });
      expect(write).toMatchObject({
        ok: true,
        result: { sourceRef: table!.ref, sourceType: 'table', format: 'text', size: expect.any(Number) },
      });
      const saved = await sandbox.read('workspace/forex.txt');
      expect(saved.content).toContain('Exchange Rate of 24-September-2026 10:00 AM');
      expect(saved.content).toContain('Japanese Yen | JPY | 10 | 9.69 | 9.69 | 9.78');
      expect(saved.content).toContain('Indian Currency | INR | 100 | 160.00 | 160.00 | 160.15');
      expect(saved.content).not.toContain('Current Account');
      expect(saved.content).not.toContain('Saving Account');

      const csvWrite = await runtime.dispatch({
        id: 'forex-csv-source-ref-write',
        method: 'fs.write',
        params: { path: 'workspace/forex.csv', sourceRef: table!.ref, format: 'csv' },
      });
      expect(csvWrite).toMatchObject({ ok: true, result: { sourceType: 'table', format: 'csv' } });
      const csv = await sandbox.read('workspace/forex.csv');
      expect(csv.content.split('\n')[0]).toBe('Currency,Code,Unit,Buying: Cash below Deno 50,Buying: Cash 50 and above Deno,Selling');
      expect(csv.content.split('\n')).toContain('Indian Currency,INR,100,160.00,160.00,160.15');
      expect(csv.content).not.toContain('# Foreign Exchange Rate');

      const semanticPath = await fixture('semantic-pages.html');
      await controller.navigate({ url: pathToFileURL(semanticPath).href });
      const spanTable = await controller.read({ query: 'currency region buy sell' });
      const extractedTables = spanTable.blocks?.filter(block => block.type === 'table') ?? [];
      expect(spanTable.diagnostics?.tableCount).toBeGreaterThanOrEqual(2);
      expect(extractedTables[0]).toMatchObject({
        columns: ['Currency', 'Rate: Buy', 'Rate: Sell'],
        rows: [['USD', '152.28', '153.65'], ['USD', 'Weekly average', 'Weekly average']],
      });
      expect(extractedTables[0]?.cellSpans?.[0]).toEqual([
        { rowspan: 2, colspan: 1 },
        { rowspan: 1, colspan: 2 },
      ]);
      const grid = await controller.read({ query: 'symbol price change' });
      expect(grid.blocks?.find(block => block.type === 'table')).toMatchObject({
        columns: ['Symbol', 'Price', 'Change'],
        rows: [['KST', '48.20', '+1.20']],
      });
      const code = await controller.read({ query: 'createClient retry local options' });
      expect(code.blocks?.some(block => block.type === 'code' && block.preview?.includes('createClient'))).toBe(true);
      const frame = await controller.read({ query: 'Saffron-204 accessible embedded panel' });
      expect(frame.blocks?.some(block => block.source?.frameUrl && block.preview?.includes('Saffron-204'))).toBe(true);

      const articlePath = await fixture('article.html');
      await controller.navigate({ url: pathToFileURL(articlePath).href });
      const article = await controller.read({ query: 'Cedar-731 preservation method' });
      expect(article.pageType).toBe('article');
      expect(article.blocks?.some(block => block.source?.extractor === 'readability')).toBe(true);
      expect(article.blocks?.[0]?.preview).toContain('Cedar-731');
      expect(article.blocks?.filter(block => block.preview?.includes('Cedar-731'))).toHaveLength(1);
      expect(article.blocks?.some(block => block.boilerplate && block.preview?.includes('Large footer'))).toBe(false);

      expect(extractAccessibleCandidate([
        { role: 'heading', name: 'Duplicate accessible heading' },
        { role: 'heading', name: 'Duplicate accessible heading' },
      ])).toBe('Duplicate accessible heading');

      const ariaPath = await fixture('aria-only.html');
      await controller.navigate({ url: pathToFileURL(ariaPath).href });
      const ariaOnly = await controller.read({ query: 'Violet-588 accessible system status' });
      expect(ariaOnly.diagnostics?.extractors).toContain('aria');
      expect(ariaOnly.blocks?.some(block => block.source?.extractor === 'aria' && block.preview?.includes('Violet-588'))).toBe(true);

      const resultsPath = await fixture('search-results.html');
      await controller.navigate({ url: pathToFileURL(resultsPath).href });
      const searchResults = await controller.read({ query: 'historical currency rate tables' });
      expect(searchResults.pageType).toBe('search_results');
      expect(searchResults.blocks?.[0]).toMatchObject({
        type: 'search_result',
        title: 'Exchange archive',
        href: 'https://archive.example.test/rates',
        snippet: expect.stringContaining('Historical currency rate tables'),
      });
      expect(searchResults.blocks?.find(block => block.title === 'Resolved search result')?.href)
        .toBe('https://results.example.test/resolved');
      const actualHrefResult = await controller.read({ query: 'observed redirect parameter' });
      expect(actualHrefResult.blocks?.find(block => block.title === 'Observed redirect parameter')?.href)
        .toBe('https://redirect.example.test/out?uddg=https%3A%2F%2Fwrong.example.test%2Fdestination');

      const dynamicPath = await fixture('dynamic-table.html');
      await controller.navigate({ url: pathToFileURL(dynamicPath).href });
      const dynamic = await controller.read({ query: 'dynamic exchange rates buying selling' });
      expect(dynamic.blocks?.[0]).toMatchObject({ type: 'table', columns: ['Currency', 'Buying', 'Selling'] });
      expect(dynamic.blocks?.[0]?.rows).toEqual([['CHF', '170.10', '171.00']]);

      const staleWrite = await runtime.dispatch({
        id: 'stale-source-ref-write',
        method: 'fs.write',
        params: { path: 'workspace/stale.txt', sourceRef: table!.ref, format: 'text' },
      });
      expect(staleWrite).toMatchObject({ ok: false, error: { code: 'STALE_CONTENT_REF' } });
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
