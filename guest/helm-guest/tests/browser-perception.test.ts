import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { GuestRpcError } from '../src/errors';
import { BrowserController } from '../src/browser';
import { GuestSandbox } from '../src/sandbox';

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
      <script>setTimeout(() => { document.querySelector('#dynamic').textContent = 'Updated dynamic text'; }, 250);</script>
      <footer>${'<p>Unrelated footer content for bounded extraction.</p>'.repeat(80)}</footer>
    </body></html>`;
    const pagePath = await sandbox.write('workspace/large.html', html);
    const nextPath = await sandbox.write('workspace/next.html', '<!doctype html><title>Next page</title><main><h1>Next</h1></main>');

    try {
      await controller.navigate({ url: pathToFileURL(pagePath.path).href });
      const snapshot = await controller.snapshot();
      const elementRef = snapshot.elements[0]?.ref;
      expect(snapshot.outline.length).toBeLessThanOrEqual(60);
      expect(snapshot.elements.length).toBeLessThanOrEqual(80);
      expect(JSON.stringify(snapshot)).not.toContain('Unrelated article paragraph 179');
      expect(JSON.stringify(snapshot).length).toBeLessThan(30_000);

      const search = await controller.searchPage({ query: 'foreign exchange currency buying selling rates', maxResults: 5 });
      expect(search.results[0]).toMatchObject({ kind: 'table', rowCount: 2, columnCount: 4 });
      expect(search.results.length).toBeLessThanOrEqual(5);
      expect(JSON.stringify(search).length).toBeLessThan(12_000);
      const nestedSearch = await controller.searchPage({ query: 'currency buying selling rates', maxResults: 10 });
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

      const formSearch = await controller.searchPage({ query: 'email address verification code' });
      expect(formSearch.results[0]?.kind).toBe('form');
      expect(JSON.stringify(formSearch).length).toBeLessThan(12_000);

      const largeTableSearch = await controller.searchPage({ query: 'catalog item code description' });
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

      const relevant = await controller.extractText({ query: 'Kestrel-482 exchange review marker', maxChars: 1_000 });
      expect(relevant.text).toContain('Kestrel-482 exchange review marker');
      expect(relevant.text).not.toContain('Earlier body passage 0');
      expect(relevant.text.length).toBeLessThanOrEqual(1_000);
      expect(JSON.stringify(relevant)).not.toContain('Earlier body passage 0');

      await new Promise(resolve => setTimeout(resolve, 350));
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
    } finally {
      await controller.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
