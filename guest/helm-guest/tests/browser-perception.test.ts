import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { guestMethodSchemas } from '../../../packages/shared/src/schemas';

import { GuestRpcError } from '../src/errors';
import { BrowserController, extractDuckDuckGoSearchPage } from '../src/browser';
import { GuestRuntime } from '../src/runtime';
import { GuestSandbox } from '../src/sandbox';
import { extractAccessibleCandidate } from '../src/semantic-extraction';

describe('progressive browser perception', () => {
  it('provides bounded DOM query and page-context evaluation fallbacks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-inspection-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const runtime = new GuestRuntime({ sandbox, browser: controller });
    try {
      const file = await sandbox.write('workspace/inspection.html', `<!doctype html><html><body>
        <div id="rate-metadata" data-currency="USD" data-rate="133.20">Current market snapshot</div>
        <table><tr><th>Currency</th><th>Buy</th></tr><tr><td>USD</td><td>133.20</td></tr></table>
      </body></html>`);
      await controller.navigate({ url: pathToFileURL(file.path).href });

      const queried = await runtime.dispatch({
        id: 'dom-query',
        method: 'browser.query',
        params: { selector: '[data-rate]' },
      });
      expect(queried).toMatchObject({
        ok: true,
        result: {
          results: [expect.objectContaining({
            tag: 'div',
            attributes: { id: 'rate-metadata', 'data-currency': 'USD', 'data-rate': '133.20' },
          })],
        },
      });

      const evaluated = await runtime.dispatch({
        id: 'page-evaluate',
        method: 'browser.evaluate',
        params: {
          expression: `[...document.querySelectorAll('table tr')].map(row => [...row.cells].map(cell => cell.innerText.trim()))`,
        },
      });
      expect(evaluated).toMatchObject({
        ok: true,
        result: { result: [['Currency', 'Buy'], ['USD', '133.20']] },
      });

      const hostApiProbe = await runtime.dispatch({
        id: 'page-context-only',
        method: 'browser.evaluate',
        params: { expression: 'typeof process' },
      });
      expect(hostApiProbe).toMatchObject({ ok: true, result: { result: 'undefined' } });

      const oversized = await runtime.dispatch({
        id: 'bounded-evaluation',
        method: 'browser.evaluate',
        params: { expression: `'x'.repeat(100_000)` },
      });
      expect(oversized).toMatchObject({ ok: false, error: { code: 'BROWSER_EVALUATE_FAILED', message: expect.stringContaining('64 KB') } });
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('returns no semantic match for an unrelated query and exposes tables through document mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-primary-table-'));
    const workspace = join(root, 'workspace');
    const sandbox = new GuestSandbox({ root, workspace });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    try {
      const file = await sandbox.write('workspace/data.html', `<!doctype html><html><body>
        <nav><ul><li><a href="/statistics">Statistics</a></li><li><a href="/reports">Data & Reports</a></li></ul></nav>
        <main><h1>Current figures</h1><table><tr><th>Currency</th><th>Buy</th><th>Sell</th></tr>
        <tr><td>USD</td><td>133.20</td><td>134.10</td></tr></table></main></body></html>`);
      await controller.navigate({ url: pathToFileURL(file.path).href });
      const noMatch = await controller.read({ query: 'qzxwvv-9347182-uniquetoken' });
      expect(noMatch.blocks).toHaveLength(0);
      expect(noMatch.diagnostics?.tableCount).toBe(1);
      const read = await controller.read({ mode: 'document', blockTypes: ['table'] });
      expect(read.pageType).toBe('data_table');
      expect(read.blocks?.[0]).toMatchObject({ type: 'table', ref: expect.any(String) });
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('recovers a navigation that committed before a transient goto error, but leaves a real load failure failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-navigation-recovery-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    try {
      const file = await sandbox.write('workspace/recovered.html', '<!doctype html><html><head><title>Recovered</title></head><body><main><h1>Usable page</h1><p>Current content is ready.</p></main></body></html>');
      await controller.start();
      const page = (controller as unknown as { page: { goto: (url: string, options?: { waitUntil?: string; timeout?: number }) => Promise<unknown> } }).page;
      const originalGoto = page.goto.bind(page);
      page.goto = async (url, options) => {
        await originalGoto(url, options);
        throw new Error('net::ERR_EMPTY_RESPONSE');
      };

      const recovered = await controller.navigate({ url: pathToFileURL(file.path).href });
      page.goto = originalGoto;
      expect(recovered).toMatchObject({
        url: pathToFileURL(file.path).href,
        title: 'Recovered',
        navigationRecovery: { originalError: 'net::ERR_EMPTY_RESPONSE' },
      });
      const read = await controller.read({ query: 'current content' });
      expect(read.url).toBe(recovered.url);
      expect(read.readable).toBe(true);

      page.goto = async () => { throw new Error('net::ERR_NAME_NOT_RESOLVED'); };
      await expect(controller.navigate({ url: 'https://missing.example.test/' })).rejects.toMatchObject({
        code: 'BROWSER_NAVIGATION_FAILED',
        message: expect.stringContaining('ERR_NAME_NOT_RESOLVED'),
      });
      page.goto = originalGoto;
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('exports a query-selected logical data document independent of its compact preview', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-query-document-repro-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const runtime = new GuestRuntime({ sandbox, browser: controller });
    try {
      const html = await readFile(new URL('./fixtures/forex-two-tables.html', import.meta.url), 'utf8');
      const file = await sandbox.write('workspace/query-document.html', html);
      await controller.navigate({ url: pathToFileURL(file.path).href });

      const read = await controller.read({ mode: 'document', query: 'exchange rate data', maxChars: 300 });
      const documentRef = read.documentRef;
      expect(read.diagnostics?.tableCount).toBe(2);
      expect(read.blocks?.length).toBeGreaterThan(0);
      expect(read.returnedChars).toBeLessThanOrEqual(300);
      expect(read.truncated).toBe(true);
      expect(documentRef).toBeDefined();
      expect(read.diagnostics).toMatchObject({
        documentTableCount: 2,
        documentStructuredBlockCount: 2,
        documentSourceRefs: expect.arrayContaining([
          expect.objectContaining({ ref: expect.any(String), type: 'table' }),
          expect.objectContaining({ ref: expect.any(String), type: 'table' }),
        ]),
      });
      expect(read.blocks?.length).toBeLessThan(2);

      const write = await runtime.dispatch({
        id: 'reproduce-query-document-export',
        method: 'fs.write',
        params: { path: 'workspace/query-document.txt', sourceRef: documentRef!, format: 'text' },
      });
      expect(write).toMatchObject({ ok: true, result: {
        sourceRef: documentRef,
        sourceType: 'document',
        sourceRefs: expect.arrayContaining(read.sourceRefs!),
        sourceTableCount: 2,
        sourceStructuredBlockCount: 2,
      } });
      const exported = (await sandbox.read('workspace/query-document.txt')).content;
      for (const currency of ['Indian Rupee (INR)', 'US Dollar (USD)', 'Euro (EUR)', 'British Pound (GBP)', 'Japanese Yen (JPY)']) {
        expect(exported).toContain(currency);
      }
      expect(exported).not.toContain('Board of Directors');
      expect(exported).not.toContain('About NRB');
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('does not add a nearby table with a different schema and document section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-unrelated-table-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const runtime = new GuestRuntime({ sandbox, browser: controller });
    try {
      const file = await sandbox.write('workspace/related-and-unrelated.html', `<!doctype html><html><body><main>
        <h1>Bulletin</h1>
        <table><caption>Daily Exchange Rates</caption><tr><th>Currency</th><th>Unit</th><th>Buy</th><th>Sell</th></tr><tr><td>USD</td><td>1</td><td>153</td><td>154</td></tr></table>
        <table><tr><th>Currency</th><th>Unit</th><th>Buy</th><th>Sell</th></tr><tr><td>INR</td><td>100</td><td>160</td><td>161</td></tr></table>
        <section><h2>Weather observations</h2><table><caption>Daily Rainfall</caption><tr><th>Station</th><th>Millimeters</th></tr><tr><td>Kathmandu</td><td>12</td></tr></table></section>
      </main></body></html>`);
      await controller.navigate({ url: pathToFileURL(file.path).href });
      const read = await controller.read({ mode: 'document', query: 'exchange rate data' });
      expect(read.diagnostics?.tableCount).toBe(3);
      expect(read.diagnostics?.documentTableCount).toBe(2);

      const write = await runtime.dispatch({
        id: 'write-related-table-group',
        method: 'fs.write',
        params: { path: 'workspace/rates.txt', sourceRef: read.documentRef!, format: 'text' },
      });
      expect(write.ok).toBe(true);
      const content = (await sandbox.read('workspace/rates.txt')).content;
      expect(content).toContain('USD');
      expect(content).toContain('INR');
      expect(content).not.toContain('Kathmandu');
      expect(content).not.toContain('Daily Rainfall');
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('preserves distinct same-heading tables and exports the selected document snapshot losslessly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-document-ref-'));
    const workspace = join(root, 'workspace');
    const sandbox = new GuestSandbox({ root, workspace });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const runtime = new GuestRuntime({ sandbox, browser: controller });
    const fixture = async (name: string): Promise<string> => {
      const html = await readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
      return (await sandbox.write(`workspace/${name}`, html)).path;
    };
    try {
      const forexPath = await fixture('forex-two-tables.html');
      await controller.navigate({ url: pathToFileURL(forexPath).href });
      const read = await controller.read({ mode: 'document', blockTypes: ['table'], maxBlocks: 20, maxChars: 4_000 });
      const documentRef = read.documentRef;
      const tables = read.blocks?.filter(block => block.type === 'table') ?? [];
      expect(documentRef).toMatch(/^d\d+-/u);
      expect(read).toMatchObject({ pageType: 'data_table', mode: 'document', documentRef });
      expect(read.diagnostics).toMatchObject({
        blockCount: expect.any(Number),
        tableCount: 2,
        selectedBlockCount: 2,
        structuredBlockCount: 2,
        sourceTruncated: false,
        summariesArePreviews: true,
      });
      expect(tables).toHaveLength(2);
      expect(tables[0]?.ref).not.toBe(tables[1]?.ref);
      expect(tables.map(block => block.rowCount)).toEqual([1, 4]);
      expect(read.diagnostics?.structuredBlocks?.map(block => ({ type: block.type, selected: block.selected, rowCount: block.rowCount }))).toEqual([
        { type: 'table', selected: true, rowCount: 1 },
        { type: 'table', selected: true, rowCount: 4 },
      ]);

      const limited = await controller.read({ mode: 'document', blockTypes: ['table'], maxBlocks: 1 });
      expect(limited.blocks).toHaveLength(1);
      expect(limited.diagnostics?.tableCount).toBe(2);
      expect(limited.diagnostics?.structuredBlocks?.filter(block => !block.selected)).toHaveLength(1);
      const pageRelevanceRead = await controller.read({ query: 'body', maxBlocks: 1 });
      expect(pageRelevanceRead.query).toBe('body');
      expect(pageRelevanceRead.blocks).toHaveLength(0);
      expect(pageRelevanceRead.diagnostics?.structuredBlocks?.filter(block => block.type === 'table' && !block.selected)).toHaveLength(2);
      const domRead = await controller.query({ selector: 'table tr', limit: 3 });
      expect(domRead.results).toHaveLength(3);

      const paged = await controller.read({ ref: tables[1]!.ref, offset: 1, limit: 2 });
      expect(paged.blocks?.[0]).toMatchObject({
        type: 'table',
        offset: 1,
        returnedRowCount: 2,
        nextOffset: 3,
        rows: [
          ['Euro (EUR)', '1', '174.30', '174.98'],
          ['British Pound (GBP)', '1', '205.10', '205.80'],
        ],
      });

      const internals = controller as unknown as { page: { locator: (selector: string) => { evaluateAll: (fn: (nodes: readonly unknown[]) => unknown) => Promise<unknown> } } };
      await internals.page.locator('body').evaluateAll(nodes => {
        const body = nodes[0] as HTMLElement;
        body.dataset.unrelatedMutation = 'ready';
        return true;
      });
      const otherPath = await fixture('article.html');
      await controller.navigate({ url: pathToFileURL(otherPath).href });
      expect(guestMethodSchemas['fs.write'].safeParse({
        path: 'workspace/multi-rates.txt', sourceRef: documentRef, format: 'text',
      }).success).toBe(true);
      const textWrite = await runtime.dispatch({
        id: 'write-composite-text',
        method: 'fs.write',
        params: { path: 'workspace/multi-rates.txt', sourceRef: documentRef!, format: 'text' },
      });
      expect(textWrite).toMatchObject({ ok: true, result: {
        sourceRef: documentRef,
        sourceType: 'document',
        sourceUrl: pathToFileURL(forexPath).href,
        sourceRevision: read.revision,
        sourceRefs: [tables[0]!.ref, tables[1]!.ref],
        sourceCapturedAt: expect.any(String),
      } });
      const text = await sandbox.read('workspace/multi-rates.txt');
      for (const currency of ['Indian Rupee (INR)', 'US Dollar (USD)', 'Euro (EUR)', 'British Pound (GBP)', 'Japanese Yen (JPY)']) {
        expect(text.content).toContain(currency);
      }

      const jsonWrite = await runtime.dispatch({
        id: 'write-composite-json',
        method: 'fs.write',
        params: { path: 'workspace/multi-rates.json', sourceRef: documentRef!, format: 'json' },
      });
      expect(jsonWrite.ok).toBe(true);
      const json = JSON.parse((await sandbox.read('workspace/multi-rates.json')).content) as {
        type: string; sourceUrl: string; sourceRefs: string[]; blocks: Array<{ ref: string; type: string; rows: string[][] }>;
      };
      expect(json).toMatchObject({
        type: 'document',
        sourceUrl: pathToFileURL(forexPath).href,
        sourceRefs: [tables[0]!.ref, tables[1]!.ref],
      });
      expect(json.blocks.map(block => block.ref)).toEqual([tables[0]!.ref, tables[1]!.ref]);
      expect(json.blocks.flatMap(block => block.rows.flat()).join(' ')).toContain('Japanese Yen (JPY)');
      const csvWrite = await runtime.dispatch({
        id: 'write-ambiguous-composite-csv',
        method: 'fs.write',
        params: { path: 'workspace/multi-rates.csv', sourceRef: documentRef!, format: 'csv' },
      });
      expect(csvWrite).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CONTENT_FORMAT', message: expect.stringContaining('single table block with no other blocks') } });

      const mixedPath = (await sandbox.write('workspace/mixed-document.html', `<!doctype html><html><body><main>
        <h1>Table notes</h1><p>Rates have one supporting note.</p>
        <table><tr><th>Currency</th><th>Rate</th></tr><tr><td>USD</td><td>133.20</td></tr></table>
      </main></body></html>`)).path;
      await controller.navigate({ url: pathToFileURL(mixedPath).href });
      const mixedDocument = await controller.read({ mode: 'document', maxBlocks: 20 });
      expect(mixedDocument.documentRef).toBeDefined();
      const mixedCsvWrite = await runtime.dispatch({
        id: 'write-mixed-document-csv',
        method: 'fs.write',
        params: { path: 'workspace/mixed-rates.csv', sourceRef: mixedDocument.documentRef, format: 'csv' },
      });
      expect(mixedCsvWrite).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_CONTENT_FORMAT', message: expect.stringContaining('3 blocks and 1 tables') } });
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('deduplicates exact list, definition, and form blocks while retaining different content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-structured-dedupe-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    try {
      const file = await sandbox.write('workspace/duplicates.html', `<!doctype html><html><body><main>
        <h1>Reference</h1>
        <ul><li>Alpha item</li></ul><ul><li>Alpha item</li></ul><ul><li>Beta item</li></ul>
        <dl><dt>Term</dt><dd>Definition text</dd></dl><dl><dt>Term</dt><dd>Definition text</dd></dl>
        <form><label>Email <input name="email" type="email" value="a@example.test"></label></form>
        <form><label>Email <input name="email" type="email" value="a@example.test"></label></form>
      </main></body></html>`);
      await controller.navigate({ url: pathToFileURL(file.path).href });
      const read = await controller.read({ mode: 'document', maxBlocks: 20 });
      expect(read.blocks?.filter(block => block.type === 'list')).toHaveLength(2);
      expect(read.blocks?.filter(block => block.type === 'definition')).toHaveLength(1);
      expect(read.blocks?.filter(block => block.type === 'form')).toHaveLength(1);
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('keeps snapshots bounded, finds late tables, extracts relevant passages, and rejects stale element refs', async () => {
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
    const largeTableHtml = `<!doctype html><html><head><title>Large table</title></head><body><main><h1>Catalog</h1>
      <table id="large"><thead><tr><th>Item</th><th>Code</th><th>Description</th></tr></thead><tbody>${largeRows}</tbody></table>
    </main></body></html>`;
    const pagePath = await sandbox.write('workspace/large.html', html);
    const nextPath = await sandbox.write('workspace/next.html', '<!doctype html><title>Next page</title><main><h1>Next</h1></main>');
    const portfolioPath = await sandbox.write('workspace/portfolio.html', portfolioHtml);
    const bodyFallbackPath = await sandbox.write('workspace/body-fallback.html', bodyFallbackHtml);
    const largeReadPath = await sandbox.write('workspace/large-read.html', largeReadHtml);
    const largeTablePath = await sandbox.write('workspace/large-table.html', largeTableHtml);

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

      const search = await controller.findPage({ query: 'foreign exchange currency buying selling rates', maxResults: 5 });
      expect(search.results[0]).toMatchObject({ type: 'table', rowCount: 2, columnCount: 4 });
      expect(search).toMatchObject({ operation: 'find_page', pageSearchCompleted: true, pageReadable: true });
      expect(search.matchCount).toBe(search.results.length);
      expect(search.matchCount).toBeGreaterThan(0);
      expect(search.results.length).toBeLessThanOrEqual(5);
      expect(JSON.stringify(search).length).toBeLessThan(12_000);
      const noMatchSearch = await controller.findPage({ query: 'qzxwvv-9347182-uniquetoken' });
      expect(noMatchSearch).toMatchObject({
        operation: 'find_page', pageSearchCompleted: true, matchCount: 0, pageReadable: true,
        message: 'Current-page search found no matching semantic content.',
      });
      const nestedSearch = await controller.findPage({ query: 'currency buying selling rates', maxResults: 10 });
      expect(nestedSearch.results.filter(result => ['table', 'text', 'other'].includes(result.type))).toHaveLength(1);
      const tableRef = search.results[0]!.ref;
      const inspected = await controller.read({ ref: tableRef, limit: 20 });
      expect(inspected.blocks?.[0]).toMatchObject({
        type: 'table',
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

      const formSearch = await controller.findPage({ query: 'email address verification code' });
      expect(formSearch.results[0]?.type).toBe('form');
      expect(JSON.stringify(formSearch).length).toBeLessThan(12_000);

      const relevantSearch = await controller.findPage({ query: 'Kestrel-482 exchange review marker' });
      const relevant = relevantSearch.results.map(result => result.preview ?? '').join('\n');
      expect(relevant).toContain('Kestrel-482 exchange review marker');
      expect(relevant).not.toContain('Earlier body passage 0');
      expect(relevant.length).toBeLessThanOrEqual(5 * 800);

      await controller.click(updateRef!);
      const changed = await controller.getState();
      expect(changed.revision).toBeGreaterThan(snapshot.revision);
      const tableSnapshot = await controller.read({ ref: tableRef });
      expect(tableSnapshot.blocks?.[0]).toMatchObject({ type: 'table', columns: ['Currency', 'Unit', 'Buying', 'Selling'] });
      if (elementRef) {
        await expect(controller.click(elementRef)).rejects.toMatchObject({ code: 'STALE_ELEMENT_REF' });
      }

      await controller.navigate({ url: pathToFileURL(largeTablePath.path).href });
      const largeTableSearch = await controller.findPage({ query: 'item code description' });
      const largeTableRef = largeTableSearch.results.find(result => result.type === 'table')?.ref;
      expect(largeTableRef).toBeDefined();
      const tablePage = await controller.read({ ref: largeTableRef!, offset: 100, limit: 10 });
      expect(tablePage.blocks?.[0]).toMatchObject({
        type: 'table',
        rowCount: 240,
        returnedRowCount: 10,
        offset: 100,
      });
      expect(tablePage.truncated).toBe(true);
      expect(JSON.stringify(tablePage).length).toBeLessThan(12_000);
      expect(tablePage.blocks?.[0]?.rows?.[0]?.[0]).toBe('Item-100');

      const beforeNavigation = await controller.snapshot();
      const staleRef = beforeNavigation.outline[0]?.ref;
      await controller.navigate({ url: pathToFileURL(nextPath.path).href });
      if (staleRef) {
        await expect(controller.inspectRegion({ ref: staleRef })).rejects.toMatchObject({ code: 'STALE_REGION_REF' });
      }

      await controller.navigate({ url: pathToFileURL(portfolioPath.path).href });
      const portfolio = await controller.read({ query: 'Self-taught software engineer Work Outside software Work with me' });
      const portfolioText = portfolio.blocks?.map(block => block.preview ?? '').join('\n') ?? '';
      expect(portfolio).toMatchObject({ operation: 'read', readable: true, mode: 'readable', source: 'semantic' });
      expect(portfolioText).toContain('Self-taught software engineer from Nepal');
      expect(portfolioText).toContain('Work');
      expect(portfolioText).toContain('Outside software');
      expect(portfolioText).toContain('Work with me');
      expect(portfolioText).not.toContain('Navigation boilerplate');
      expect(portfolioText).not.toContain('Footer boilerplate');

      const portfolioSnapshot = await controller.snapshot();
      const mainRef = portfolioSnapshot.outline.find(region => region.kind === 'section')?.ref;
      expect(mainRef).toBeDefined();
      const fullRegion = await controller.inspectRegion({ ref: mainRef!, maxChars: 5_000 });
      expect(fullRegion.format).toBe('text');
      expect(fullRegion.text).toContain('PIANO-REGION-9284');

      await controller.navigate({ url: pathToFileURL(bodyFallbackPath.path).href });
      const bodyFallback = await controller.read({ query: 'Visible body content' });
      const bodyFallbackText = JSON.stringify(bodyFallback.blocks ?? []);
      expect(bodyFallback).toMatchObject({ source: 'semantic', readable: true });
      expect(bodyFallbackText).toContain('Visible body content');
      expect(bodyFallbackText).not.toContain('Navigation fallback noise');
      expect(bodyFallbackText).not.toContain('ARIA-HIDDEN-SECRET');
      expect(bodyFallbackText).not.toContain('HIDDEN-SECRET');
      expect(bodyFallbackText).not.toContain('SCRIPT-SECRET');
      expect(bodyFallbackText).not.toContain('NOSCRIPT-SECRET');
      expect(bodyFallbackText).not.toContain('SVG-SECRET');

      await controller.navigate({ url: pathToFileURL(largeReadPath.path).href });
      const largeSearch = await controller.read({ query: 'Chapter 0 paragraph with bounded continuation content' });
      const textRef = largeSearch.blocks?.find(block => block.type === 'text')?.ref;
      expect(textRef).toBeDefined();
      const firstChunk = await controller.read({ ref: textRef!, maxChars: 300 });
      expect(firstChunk.blocks?.[0]?.returnedChars).toBe(300);
      expect(firstChunk.truncated).toBe(true);
      expect(firstChunk.blocks?.[0]?.nextOffset).toBe(300);
      expect(JSON.stringify(firstChunk).length).toBeLessThan(2_500);
      const secondChunk = await controller.read({ ref: textRef!, maxChars: 300, offset: 300 });
      expect(secondChunk.returnedChars).toBeGreaterThan(0);
      expect(secondChunk.sections.map(section => section.text).join('\n')).not.toBe(firstChunk.sections.map(section => section.text).join('\n'));
      expect(secondChunk.totalChars).toBeGreaterThan(500);
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('opens an observed page link by semantic ref and rejects refs after navigation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-browser-open-ref-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    let destinationUrl = '';
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/search') {
        response.end(`<!doctype html><html><head><title>Search page</title></head><body><main>
          <h1>Local results</h1>
          <form role="search"><input type="search" name="q" value="foreign exchange rates"></form>
          <article data-testid="result"><h2><a href="${destinationUrl}">Official foreign exchange rates</a></h2><p>Local observed result with currency buying and selling values.</p></article>
          <article data-testid="result"><h2><a href="http://127.0.0.1:${addressPort()}/archive">Currency archive</a></h2><p>Historical tables and prior rates.</p></article>
          <article data-testid="result"><h2><a href="http://127.0.0.1:${addressPort()}/news">Exchange rate news</a></h2><p>Recent market commentary and reports.</p></article>
        </main></body></html>`);
      } else {
        response.end('<!doctype html><html><head><title>Rates page</title></head><body><main><h1>Rates</h1><p>Destination loaded.</p></main></body></html>');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a local HTTP server address.');
    destinationUrl = `http://127.0.0.1:${address.port}/forex`;
    const searchUrl = `http://127.0.0.1:${address.port}/search`;
    function addressPort(): number { return address.port; }

    try {
      await controller.navigate({ url: searchUrl });
      const search = await controller.findPage({ query: 'official foreign exchange rates currency buying selling' });
      const result = search.results.find(block => block.href === destinationUrl);
      expect(result?.type).toBe('search_result');
      expect(typeof result?.ref).toBe('string');
      expect(result?.ref.startsWith('n-')).toBe(true);
      expect(result?.href).toBe(destinationUrl);

      const opened = await controller.open({ ref: result!.ref });
      expect(opened).toMatchObject({ openedHref: destinationUrl, url: destinationUrl, sourceType: result!.type });
      // Navigation capabilities survive navigation; reopening the same observed
      // destination must still succeed.
      const reopened = await controller.open({ ref: result!.ref });
      expect(reopened).toMatchObject({ openedHref: destinationUrl, url: destinationUrl });
    } finally {
      await controller.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('ranks semantic blocks, exports complete content refs, and preserves snapshots across page revisions', async () => {
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
      expect(forex.blocks?.[0]?.type).toBe('table');
      expect(forex.blocks?.some(block => block.type === 'search_result')).toBe(false);
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
        rowCount: 12,
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
      expect(repeated.blocks?.[0]).toMatchObject({ type: 'table', columns: table?.columns });
      expect(repeated.blocks?.[0]?.ref).not.toBe(table?.ref);
      const fullTable = await controller.read({ ref: table!.ref, limit: 20 });
      expect(fullTable.blocks?.[0]?.rows).toEqual([
        ['USD', 'USD', '1', '152.28', '153.05', '153.65'],
        ['Euro', 'EUR', '1', '173.65', '173.65', '175.36'],
        ['Japanese Yen', 'JPY', '10', '9.69', '9.69', '9.78'],
        ['Indian Currency', 'INR', '100', '160.00', '160.00', '160.15'],
        ['British Pound', 'GBP', '1', '205.10', '205.80', '206.50'],
        ['Swiss Franc', 'CHF', '1', '181.20', '181.90', '182.60'],
        ['Australian Dollar', 'AUD', '1', '98.10', '98.50', '99.00'],
        ['Canadian Dollar', 'CAD', '1', '110.10', '110.55', '111.00'],
        ['Singapore Dollar', 'SGD', '1', '112.20', '112.65', '113.10'],
        ['Chinese Yuan', 'CNY', '1', '20.90', '21.00', '21.10'],
        ['Qatari Riyal', 'QAR', '1', '41.50', '41.65', '41.80'],
        ['Saudi Riyal', 'SAR', '1', '40.40', '40.55', '40.70'],
      ]);
      expect(fullTable.blocks?.[0]?.cellSpans?.[0]).toEqual([
        { rowspan: 2, colspan: 1 },
        { rowspan: 2, colspan: 1 },
        { rowspan: 2, colspan: 1 },
        { rowspan: 1, colspan: 2 },
        { rowspan: 2, colspan: 1 },
      ]);

      const previous = await sandbox.write('workspace/forex.txt', 'OLD DATA');
      const internals = controller as unknown as { page: { locator: (selector: string) => { evaluateAll: (fn: (nodes: readonly unknown[]) => unknown) => Promise<unknown> } } };
      await internals.page.locator('body').evaluateAll(nodes => {
        const body = nodes[0] as HTMLElement;
        body.dataset.unrelatedMutation = 'loaded';
        const decoration = document.createElement('div');
        decoration.textContent = 'Unrelated lazy page decoration';
        body.appendChild(decoration);
        return true;
      });
      await controller.getState();
      const write = await runtime.dispatch({
        id: 'forex-source-ref-write',
        method: 'fs.write',
        params: { path: 'workspace/forex.txt', sourceRef: table!.ref, format: 'text' },
      });
      expect(write).toMatchObject({
        ok: true,
        result: {
          sourceRef: table!.ref,
          sourceType: 'table',
          format: 'text',
          sourceRevision: forex.revision,
          sourceUrl: pathToFileURL(forexPath).href,
          existedBefore: true,
          beforeSha256: previous.sha256,
          changed: true,
          size: expect.any(Number),
        },
      });
      const saved = await sandbox.read('workspace/forex.txt');
      expect(saved.content).toContain('Exchange Rate of 24-September-2026 10:00 AM');
      expect(saved.content).toContain('Japanese Yen | JPY | 10 | 9.69 | 9.69 | 9.78');
      expect(saved.content).toContain('Indian Currency | INR | 100 | 160.00 | 160.00 | 160.15');
      expect(saved.content).toContain('Saudi Riyal | SAR | 1 | 40.40 | 40.55 | 40.70');
      expect(saved.content).not.toContain('OLD DATA');
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
      expect(csv.content.split('\n')).toContain('Saudi Riyal,SAR,1,40.40,40.55,40.70');
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
      const ddgSearch = await controller.findPage({ query: 'Nepal Rastra Bank foreign exchange rate' });
      const nrbResult = ddgSearch.results.find(block => block.title === 'Foreign Exchange Rate - Nepal Rastra Bank');
      expect(nrbResult).toMatchObject({
        type: 'search_result',
        ref: expect.stringMatching(/^n-[a-f0-9]{8}-/),
        href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nrb.org.np%2Fforex',
        relevance: expect.any(Number),
      });
      const ddgRead = await controller.read({ query: 'Nepal Rastra Bank foreign exchange rate' });
      expect(ddgRead.blocks?.find(block => block.title === nrbResult?.title)).toMatchObject({
        ref: nrbResult?.ref,
        type: 'search_result',
        href: 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nrb.org.np%2Fforex',
      });
      const searchResults = await controller.read({ query: 'historical currency rate tables' });
      expect(searchResults.pageType).toBe('search_results');
      expect(searchResults.blocks?.[0]).toMatchObject({
        type: 'search_result',
        title: 'Exchange archive',
        href: 'https://archive.example.test/rates',
        snippet: expect.stringContaining('Historical currency rate tables'),
      });
      expect(searchResults.blocks?.find(block => block.title === 'Resolved search result')?.href)
        .toBe('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fresults.example.test%2Fresolved');
      const actualHrefResult = await controller.read({ query: 'observed redirect parameter' });
      expect(actualHrefResult.blocks?.find(block => block.title === 'Observed redirect parameter')?.href)
        .toBe('https://redirect.example.test/out?uddg=https%3A%2F%2Fwrong.example.test%2Fdestination');

      const dynamicPath = await fixture('dynamic-table.html');
      await controller.navigate({ url: pathToFileURL(dynamicPath).href });
      const dynamic = await controller.read({ query: 'dynamic exchange rates buying selling' });
      expect(dynamic.blocks?.[0]).toMatchObject({
        type: 'table',
        columns: ['Currency', 'Buying', 'Selling'],
        rowCount: 1,
        rows: [['CHF', '170.10', '171.00']],
      });

      const evaluatedRows = await controller.evaluate({
        expression: `new Promise(resolve => {
          const started = Date.now();
          const poll = () => {
            const rows = [...document.querySelectorAll('#rates tbody tr')]
              .map(row => [...row.cells].map(cell => cell.innerText.trim()));
            if (rows.length >= 3 || Date.now() - started > 3_000) resolve(rows);
            else setTimeout(poll, 50);
          };
          poll();
        })`,
      });
      expect(evaluatedRows.result).toEqual([
        ['CHF', '170.10', '171.00'],
        ['USD', '132.10', '132.70'],
        ['EUR', '143.20', '144.00'],
      ]);
      const queriedRows = await controller.query({ selector: '#rates tbody tr', limit: 10 });
      expect(queriedRows.results.map(row => row.text)).toEqual([
        'CHF 170.10 171.00',
        'USD 132.10 132.70',
        'EUR 143.20 144.00',
      ]);

      const staleWrite = await runtime.dispatch({
        id: 'stale-source-ref-write',
        method: 'fs.write',
        params: { path: 'workspace/stale.txt', sourceRef: table!.ref, format: 'text' },
      });
      expect(staleWrite).toMatchObject({ ok: true, result: { sourceRef: table!.ref, sourceType: 'table' } });
      const afterNavigation = await sandbox.read('workspace/stale.txt');
      expect(afterNavigation.content).toContain('Indian Currency | INR | 100 | 160.00 | 160.00 | 160.15');
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});

describe('DuckDuckGo search extraction', () => {
  it('classifies the sanitized live challenge page without promoting UI links to results', async () => {
    const html = await readFile(new URL('./fixtures/ddg-live-challenge.html', import.meta.url), 'utf8');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.setContent(html);
      const result = await page.locator('body').evaluateAll(extractDuckDuckGoSearchPage as any, {
        pageUrl: 'https://duckduckgo.com/?q=Nepal+Rastra+Bank+forex+rates',
      });

      expect(result).toMatchObject({
        outcome: 'challenge',
        isSearchPage: true,
        resultCount: 0,
      });
      expect(result.challengeSignals).toContain('anomaly_modal');
      expect(result.challengeSignals).toContain('challenge_text');
      expect(result.visibleAnchorCount).toBeGreaterThan(0);
      expect(result.results).toEqual([]);
    } finally {
      await browser.close();
    }
  });

  it('extracts observed DDG result cards and preserves the exact redirect href', async () => {
    const html = await readFile(new URL('./fixtures/search-results.html', import.meta.url), 'utf8');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.setContent(html);
      const result = await page.locator('body').evaluateAll(extractDuckDuckGoSearchPage as any, {
        pageUrl: 'https://duckduckgo.com/?q=Nepal+Rastra+Bank+foreign+exchange+rate',
        maxResults: 10,
      });
      const nrb = result.results.find((item: { title: string }) => item.title.includes('Nepal Rastra Bank'));

      expect(result.outcome).toBe('results');
      expect(result.extractionStrategy).toBe('result_cards');
      expect(nrb?.href).toBe('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nrb.org.np%2Fforex');
    } finally {
      await browser.close();
    }
  });

  it('uses a constrained main-region outbound-link fallback and rejects page chrome', async () => {
    const html = `<!doctype html><html><body>
      <form role="search" action="https://duckduckgo.com/"><input name="q" type="search" value="official data"></form>
      <nav><a href="https://duckduckgo.com/settings">Settings</a><a href="https://outside.example.test/nav">External navigation</a></nav>
      <main><section><h2><a href="https://official.example.test/data">Official data source</a></h2>
        <p>Observed source result with the requested public data.</p></section></main>
      <footer><a href="https://outside.example.test/footer">Footer promo</a></footer>
    </body></html>`;
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.setContent(html);
      const result = await page.locator('body').evaluateAll(extractDuckDuckGoSearchPage as any, {
        pageUrl: 'https://duckduckgo.com/?q=official+data',
      });

      expect(result.outcome).toBe('results');
      expect(result.extractionStrategy).toBe('main_outbound_links');
      expect(result.results).toHaveLength(1);
      expect(result.results[0]).toMatchObject({
        title: 'Official data source',
        href: 'https://official.example.test/data',
        snippet: expect.stringContaining('requested public data'),
      });
    } finally {
      await browser.close();
    }
  });

  it('distinguishes explicit no-results pages from unrecognized markup', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.setContent('<form role="search"><input name="q"></form><main><p>No results found for this search.</p></main>');
      const noResults = await page.locator('body').evaluateAll(extractDuckDuckGoSearchPage as any, {
        pageUrl: 'https://duckduckgo.com/?q=unmatched',
      });
      await page.setContent('<form role="search"><input name="q"></form><main><p>Unrecognized result page markup.</p></main>');
      const parseFailure = await page.locator('body').evaluateAll(extractDuckDuckGoSearchPage as any, {
        pageUrl: 'https://duckduckgo.com/?q=unknown',
      });

      expect(noResults.outcome).toBe('no_results');
      expect(noResults.noResultsSignals).toContain('no_results_text');
      expect(parseFailure.outcome).toBe('parse_failed');
    } finally {
      await browser.close();
    }
  });
});
