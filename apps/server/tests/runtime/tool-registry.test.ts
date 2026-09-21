import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { ToolRegistry } from '../../src/tools/tool-registry';

describe('ToolRegistry', () => {
  it('validates inputs, returns a common result envelope, and records invocations', async () => {
    const registry = new ToolRegistry({ idFactory: () => 'invocation-1' });
    registry.register({
      name: 'echo',
      description: 'Echo a string.',
      inputSchema: z.object({ value: z.string() }),
      execute: async input => ({ value: input.value }),
    });

    const invalid = await registry.execute('echo', { value: 42 });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT' } });

    const valid = await registry.execute('echo', { value: 'hello' });
    expect(valid).toEqual({ ok: true, data: { value: 'hello' } });
    expect(registry.invocations).toHaveLength(2);
    expect(registry.invocations[1]?.result).toEqual(valid);
  });

  it('returns a timeout result and aborts the handler signal', async () => {
    const registry = new ToolRegistry();
    let aborted = false;
    registry.register({
      name: 'slow',
      description: 'A deliberately slow tool.',
      inputSchema: z.object({}),
      timeoutMs: 10,
      execute: async (_input, context) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 100);
          context.signal.addEventListener('abort', () => {
            aborted = true;
            clearTimeout(timer);
            reject(new Error('aborted'));
          }, { once: true });
        });
        return 'unreachable';
      },
    });

    const result = await registry.execute('slow', {});
    expect(result).toMatchObject({ ok: false, error: { code: 'TOOL_TIMEOUT' } });
    expect(aborted).toBe(true);
  });
});

