import { describe, expect, it } from 'bun:test';

import { EventHub } from '../src/events';
import { loadConfig } from '../src/config';
import { HttpGuestTransport } from '../src/vm/transport';
import { VmController } from '../src/vm/vm-controller';

const enabled = process.env.HELM_VM_INTEGRATION === '1';

describe('Apple VM integration', () => {
  if (!enabled) {
    it.skip('requires HELM_VM_INTEGRATION=1 and prepared VM images', () => undefined);
    return;
  }

  it('starts the helper, reaches the guest handshake, and stops cleanly', async () => {
    const config = loadConfig();
    const vm = new VmController(
      config,
      new EventHub(),
      new HttpGuestTransport({
        baseUrl: `http://${config.guestHost}:${config.guestPort}`,
        timeoutMs: config.toolTimeoutMs,
      }),
    );

    try {
      await vm.start();
      const status = await vm.status();
      expect(status.state).toBe('running');
      expect(status.guestConnected).toBe(true);
      const handshake = await vm.guestRequest<{
        runtime: string;
        protocolVersion: number;
      }>('guest.handshake', {});
      expect(handshake.runtime).toBe('helm-guest');
      expect(handshake.protocolVersion).toBe(1);
    } finally {
      await vm.close();
    }
  });
});
