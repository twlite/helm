import { describe, expect, it } from 'bun:test';

import { CriterionVerifierRegistry } from '../../src/tools/criterion-verifier';
import {
  DEMO_PAGE_TEXT,
  DEMO_PAGE_URL,
  MockGuestTransport,
} from '../../src/tools/mock-guest-transport';

describe('criterion verification and mock guest state', () => {
  it('verifies browser, filesystem, and focused-window criteria mechanically', async () => {
    const guest = new MockGuestTransport();
    await guest.request('browser.navigate', { url: DEMO_PAGE_URL });
    const extracted = await guest.request('browser.extractText', {});
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
