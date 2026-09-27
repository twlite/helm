import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BrowserController } from '../src/browser';
import { GuestSandbox } from '../src/sandbox';

describe('search-result navigation capabilities', () => {
  it('survives irrelevant DOM mutations while normal content refs become stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'helm-search-nav-'));
    const sandbox = new GuestSandbox({ root, workspace: join(root, 'workspace') });
    const controller = new BrowserController(sandbox, { headless: true, profilePath: 'browser-profile' });
    const destinationPath = '/forex';
    let destinationUrl = '';
    const server = createServer((request, response) => {
      response.setHeader('content-type', 'text/html; charset=utf-8');
      if (request.url === '/search') {
        const port = (server.address() as { port: number }).port;
        destinationUrl = `http://127.0.0.1:${port}${destinationPath}`;
        response.end(`<!doctype html><html><head><title>Search page</title></head><body>
          <main>
            <h1>Local results</h1>
            <form role="search"><input type="search" name="q" value="Nepal Rastra Bank forex"></form>
            <article data-testid="result"><h2><a href="${destinationUrl}">Nepal Rastra Bank Foreign Exchange</a></h2><p>Official daily rates.</p></article>
            <article data-testid="result"><h2><a href="http://127.0.0.1:${port}/other">Other rates</a></h2><p>Third party.</p></article>
            <article data-testid="result"><h2><a href="http://127.0.0.1:${port}/archive">Archive</a></h2><p>Historical.</p></article>
            <section><h2>Market data</h2><table><tr><th>Currency</th><th>Rate</th></tr><tr><td>USD</td><td>133.20</td></tr></table></section>
          </main>
          <div id="ad-container">Ad placeholder</div>
        </body></html>`);
      } else if (request.url === destinationPath) {
        response.end('<!doctype html><html><head><title>NRB Forex</title></head><body><main><h1>Foreign Exchange Rates</h1><p>USD 133.20</p></main></body></html>');
      } else {
        response.end('<!doctype html><html><body><main><h1>Other</h1></main></body></html>');
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected local address');
    const searchUrl = `http://127.0.0.1:${address.port}/search`;

    try {
      await controller.navigate({ url: searchUrl });
      const search = await controller.findPage({ query: 'Nepal Rastra Bank Foreign Exchange official' });
      const navResult = search.results.find(block => block.title?.includes('Nepal Rastra Bank'));
      expect(navResult?.type).toBe('search_result');
      expect(navResult?.ref.startsWith('n-')).toBe(true);
      const navRef = navResult!.ref;
      const navHref = navResult!.href!;
      expect(navHref).toContain('/forex');

      // Capture a normal revision-bound content ref on the same page.
      const read = await controller.read({ query: 'Market data Currency Rate' });
      const tableRef = read.blocks?.find(block => block.type === 'table')?.ref;
      expect(typeof tableRef).toBe('string');
      expect(tableRef!.startsWith('c')).toBe(true);

      // Mutate an irrelevant part of the DuckDuckGo-like DOM (ad container,
      // CSS class, lazy-loaded node) without navigating.
      const internals = controller as unknown as { page: { locator: (s: string) => { evaluateAll: (fn: (n: readonly unknown[]) => unknown) => Promise<unknown> } } };
      await internals.page.locator('body').evaluateAll((nodes) => {
        const body = nodes[0] as HTMLElement;
        body.dataset.someDynamicState = '2';
        const ad = body.querySelector('#ad-container');
        if (ad instanceof HTMLElement) {
          ad.setAttribute('class', 'ad-loaded');
          ad.textContent = 'Ad loaded lazily';
        }
        const extra = document.createElement('div');
        extra.textContent = 'Lazy decoration';
        body.appendChild(extra);
        return true;
      });
      // Force Helm's DOM revision observer to notice.
      await controller.getState();

      // Navigation capability must survive; normal content ref must be stale.
      const opened = await controller.open({ ref: navRef });
      expect(opened.openedHref).toBe(navHref);
      expect(opened.url).toContain('/forex');
      expect(opened.sourceType).toBe('search_result');

      // After navigation away, the old page content ref is stale.
      await expect(controller.read({ ref: tableRef! })).rejects.toMatchObject({ code: 'STALE_CONTENT_REF' });
    } finally {
      await controller.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
