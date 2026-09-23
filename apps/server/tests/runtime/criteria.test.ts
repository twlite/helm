import { describe, expect, it } from 'bun:test';

import { BROWSER_RESEARCH_CRITERION_ID } from '../../src/agent/browser-research';
import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import { createGuestToolRegistry } from '../../src/tools/guest-tools';
import {
  DEMO_PAGE_TITLE,
  DEMO_PAGE_TEXT,
  DEMO_PAGE_URL,
  MockGuestTransport,
} from '../../src/tools/mock-guest-transport';

describe('criterion verification and mock guest state', () => {
  it('verifies browser research only after readable page text is collected', async () => {
    const guest = new MockGuestTransport();
    const verifier = new CriterionVerifierRegistry(guest);
    const criterion = {
      type: 'custom' as const,
      id: BROWSER_RESEARCH_CRITERION_ID,
      description: 'Read current public web information with the browser before answering.',
    };

    await guest.request('browser.navigate', { url: DEMO_PAGE_URL });
    await expect(verifier.verifyTask({
      criteria: [criterion],
    }, {
      lastToolResult: { ok: true, data: { url: DEMO_PAGE_URL, title: DEMO_PAGE_TITLE } },
    })).resolves.toMatchObject({ complete: false });

    const extracted = await guest.request('browser.extractText', { query: 'Helm deterministic demo content' });
    await expect(verifier.verifyTask({
      criteria: [criterion],
    }, {
      lastToolResult: { ok: true, data: extracted },
    })).resolves.toMatchObject({ complete: true });
  });

  it('verifies browser, filesystem, and focused-window criteria mechanically', async () => {
    const guest = new MockGuestTransport();
    await guest.request('browser.navigate', { url: DEMO_PAGE_URL });
    const extracted = await guest.request('browser.extractText', { query: 'Helm deterministic demo content' });
    await guest.request('fs.write', {
      path: '/home/helm/workspace/demo.txt',
      content: extracted.text,
    });
    await guest.request('app.openFile', {
      path: '/home/helm/workspace/demo.txt',
      application: 'text-editor',
    });

    const verifier = new CriterionVerifierRegistry(guest);
    const result = await verifier.verifyTask({
      criteria: [
        { type: 'browser.url', url: DEMO_PAGE_URL },
        { type: 'file.exists', path: '/home/helm/workspace/demo.txt' },
        { type: 'file.contains', path: '/home/helm/workspace/demo.txt', expected: DEMO_PAGE_TEXT },
        { type: 'window.open', application: 'text-editor', titleIncludes: 'demo.txt' },
        { type: 'window.focused', application: 'text-editor', titleIncludes: 'demo.txt' },
      ],
    });

    expect(result.complete).toBe(true);
    expect(result.criteria.every(criterion => criterion.passed)).toBe(true);
  });

  it('rejects paths outside the isolated guest root', async () => {
    const guest = new MockGuestTransport();
    await expect(
      guest.request('fs.write', { path: '/home/helm/../outside.txt', content: 'nope' }),
    ).rejects.toMatchObject({ code: 'PATH_OUTSIDE_ALLOWED_ROOT' });
  });

  it('matches a bare hostname criterion to the canonical browser URL', async () => {
    const guest = new MockGuestTransport();
    await guest.request('browser.navigate', { url: 'https://twlite.dev' });

    const verifier = new CriterionVerifierRegistry(guest);
    const result = await verifier.verifyTask({
      criteria: [{ type: 'browser.url', url: 'twlite.dev' }],
    });

    expect(result.complete).toBe(true);
    expect(result.criteria[0]?.passed).toBe(true);
  });

  it('accepts a browser URL criterion when navigation followed a redirect', async () => {
    const sourceUrl = 'https://github.com/twlite.png';
    const finalUrl = 'https://avatars.githubusercontent.com/u/123456?v=4';
    const guest = new MockGuestTransport({
      redirects: { [sourceUrl]: finalUrl },
      pages: { [finalUrl]: '<html><body><p>profile image</p></body></html>' },
    });
    const tools = createGuestToolRegistry(guest);
    const navigation = await tools.execute('browser.navigate', { url: sourceUrl });
    const verifier = new CriterionVerifierRegistry(guest);
    const result = await verifier.verifyTask({
      criteria: [{ type: 'browser.url', url: sourceUrl }],
    }, { lastToolResult: navigation });

    expect(result.complete).toBe(true);
    expect(result.criteria[0]?.message).toContain(finalUrl);
  });

  it('reports missing criteria instead of treating them as complete', async () => {
    const guest = new MockGuestTransport();
    const verifier = new CriterionVerifierRegistry(guest);
    const result = await verifier.verifyTask({
      criteria: [{ type: 'file.exists', path: '/home/helm/workspace/missing.txt' }],
    });

    expect(result.complete).toBe(false);
    expect(result.criteria[0]?.passed).toBe(false);
  });
});
