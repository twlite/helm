import { describe, expect, it } from 'bun:test';
import type { GuestMethod } from '@helm/shared';

import { observeEnvironment } from '../../src/agent/observation';
import type { GuestTransport } from '../../src/tools/guest-transport';

describe('environment observation', () => {
  it('reads lightweight browser and desktop state without automatically requesting a page snapshot', async () => {
    const calls: GuestMethod[] = [];
    const guest = {
      async request(method: GuestMethod) {
        calls.push(method);
        if (method === 'browser.getState') {
          return {
            ready: true,
            visible: true,
            url: 'https://example.test/',
            title: 'Example',
            loading: false,
            pageCount: 2,
            revision: 7,
          };
        }
        if (method === 'desktop.getState') {
          return { focusedWindow: { title: 'Editor' }, windows: [] };
        }
        throw new Error(`Unexpected observation method ${method}`);
      },
    } as unknown as GuestTransport;

    const observation = await observeEnvironment({
      task: { id: 'run-task', goal: 'inspect a page', criteria: [] } as never,
      completedCriteria: [],
      remainingCriteria: [],
    }, { guest, now: () => 123 });

    expect(calls).toEqual(['browser.getState', 'desktop.getState']);
    expect(observation.browser).toEqual({
      url: 'https://example.test/',
      title: 'Example',
      loading: false,
      pageCount: 2,
      revision: 7,
    });
    expect(observation.desktop?.focusedWindow?.title).toBe('Editor');
    expect(observation.timestamp).toBe(123);
  });
});
