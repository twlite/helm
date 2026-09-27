import { describe, expect, it } from 'bun:test';

import { buildDuckDuckGoSearchUrl } from '@helm/shared';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import { MockGuestTransport } from '../../src/tools/mock-guest-transport';

describe('browser web search', () => {
  it('reports an unavailable results page instead of treating page chrome as search evidence', async () => {
    const query = 'official bank forex';
    const searchUrl = buildDuckDuckGoSearchUrl(query);
    const guest = new MockGuestTransport({ pages: {
      [searchUrl]: '<html><body><nav><ul><li><a href="https://duckduckgo.com/settings">Settings</a></li><li><a href="https://duckduckgo.com/about">About</a></li></ul></nav><main><h1>Please complete the challenge</h1><form><button>Submit</button></form></main></body></html>',
    } });
    const tools = createGuestToolRegistry(guest);
    const result = await tools.execute('browser.webSearch', { query });
    expect(result).toMatchObject({ ok: false, error: { code: 'WEB_SEARCH_RESULTS_UNAVAILABLE' } });
  });

  it('opens a DuckDuckGo page in the local guest, returns observed refs, and opens the selected result by ref', async () => {
    const query = 'Nepal Rastra Bank official forex';
    const searchUrl = buildDuckDuckGoSearchUrl(query);
    const destinationUrl = 'https://www.nrb.org.np/forex/';
    const guest = new MockGuestTransport({
      pages: {
        [searchUrl]: `<!doctype html><html><head><title>DuckDuckGo Search</title></head><body>
          <nav><ul><li><a href="https://example.test/home">Home</a></li><li><a href="https://example.test/news">News</a></li></ul></nav>
          <main><h1>Search results</h1>
            <article class="result"><h2><a href="${destinationUrl}">Nepal Rastra Bank | Foreign Exchange Rates</a></h2>
              <p>Official daily exchange rates published by Nepal Rastra Bank.</p></article>
            <article class="result"><h2><a href="https://rates.example.test/nepal">Nepal currency rates</a></h2>
              <p>Third party foreign exchange rate comparison.</p></article>
          </main></body></html>`,
        [destinationUrl]: '<!doctype html><html><head><title>Nepal Rastra Bank</title></head><body><main><h1>Foreign Exchange Rates</h1></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);

    expect(tools.names()).toContain('browser.webSearch');
    expect(tools.names()).toContain('browser.findPage');
    expect(tools.names()).not.toContain('browser.search');
    const pageLocalSearchOnBlank = await tools.execute('browser.findPage', { query });
    expect(pageLocalSearchOnBlank).toMatchObject({ ok: false, error: { code: 'BROWSER_NOT_READY' } });

    const search = await tools.execute('browser.webSearch', { query, maxResults: 5 });
    expect(search).toMatchObject({
      ok: true,
      data: {
        operation: 'web_search',
        searchEngine: 'duckduckgo',
        searchCompleted: true,
        requestedUrl: searchUrl,
        url: searchUrl,
        query,
        matchCount: 2,
      },
    });
    const records = (search.data as { results: Array<{ type: string; ref: string; title: string; href: string }> }).results;
    const official = records.find(result => result.href === destinationUrl);
    const officialRef = official?.ref;
    expect(official).toMatchObject({
      type: 'search_result',
      title: 'Nepal Rastra Bank | Foreign Exchange Rates',
      href: destinationUrl,
      ref: expect.stringMatching(/^c\d+-[a-f0-9]{8}-\d+$/u),
    });

    const opened = await tools.execute('browser.open', { ref: officialRef });
    expect(opened).toMatchObject({
      ok: true,
      data: { openedHref: destinationUrl, url: destinationUrl },
    });
  });

  it('keeps the exact observed DuckDuckGo redirect href in result records', async () => {
    const query = 'official forex rates';
    const searchUrl = buildDuckDuckGoSearchUrl(query);
    const observedHref = `https://duckduckgo.com/l/?uddg=${encodeURIComponent('https://www.nrb.org.np/forex/')}`;
    const guest = new MockGuestTransport({
      redirects: { [observedHref]: 'https://www.nrb.org.np/forex/' },
      pages: {
        [searchUrl]: `<!doctype html><html><body><main><article class="result">
          <h2><a href="${observedHref}">Nepal Rastra Bank Foreign Exchange</a></h2>
          <p>Official exchange rates.</p></article></main></body></html>`,
        'https://www.nrb.org.np/forex/': '<!doctype html><html><head><title>Nepal Rastra Bank</title></head><body><main><h1>Foreign Exchange Rates</h1></main></body></html>',
      },
    });
    const tools = createGuestToolRegistry(guest);

    const result = await tools.execute('browser.webSearch', { query });
    const records = (result.data as { results: Array<{ href: string }> }).results;
    expect(records[0]?.href).toBe(observedHref);
    const ref = (result.data as { results: Array<{ ref: string }> }).results[0]?.ref;
    const opened = await tools.execute('browser.open', { ref });
    expect(opened).toMatchObject({
      ok: true,
      data: { openedHref: observedHref, url: 'https://www.nrb.org.np/forex/' },
    });
  });
});
