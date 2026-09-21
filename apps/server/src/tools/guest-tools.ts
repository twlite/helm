import { guestMethodSchemas } from '@helm/shared';
import type { GuestMethod, ToolResult } from '@helm/shared';
import { z } from 'zod';

import type {
  GuestMethodParams,
  GuestTransport,
  GuestTransportError,
} from './guest-transport';
import { ToolRegistry, type ToolRegistryOptions } from './tool-registry';

const TOOL_DESCRIPTIONS: Partial<Record<GuestMethod, string>> = {
  'guest.handshake': 'Check the guest protocol and capabilities.',
  'fs.read': 'Read a UTF-8 file inside the allowed guest filesystem root.',
  'fs.write': 'Write a UTF-8 file inside the allowed guest filesystem root.',
  'fs.exists': 'Check whether a guest filesystem path exists.',
  'fs.list': 'List immediate entries inside an allowed guest directory.',
  'fs.stat': 'Inspect whether a guest filesystem path exists and its type.',
  'browser.navigate': 'Navigate the visible guest browser to a URL.',
  'browser.getState': 'Read the visible guest browser URL and loading state.',
  'browser.snapshot': 'Return a compact semantic snapshot of browser controls.',
  'browser.extractText': 'Extract readable text from the current browser page.',
  'browser.click': 'Click a semantic browser element or desktop coordinate fallback.',
  'browser.type': 'Type into a semantic browser element.',
  'app.launch': 'Launch one of the explicitly supported guest applications.',
  'app.openFile': 'Open a guest file in an explicitly supported application.',
  'desktop.getState': 'Read guest windows and the focused window.',
  'desktop.listWindows': 'List guest windows.',
  'desktop.focusWindow': 'Focus a matching guest window.',
  'desktop.hotkey': 'Send a keyboard shortcut to the guest desktop.',
  'desktop.type': 'Type text into the focused guest desktop application.',
  'desktop.click': 'Click a coordinate on the guest desktop.',
  'desktop.screenshot': 'Capture one current guest desktop screenshot.',
};

function transportFailure(error: unknown): ToolResult {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const typed = error as GuestTransportError;
    return {
      ok: false,
      error: {
        code: String(typed.code),
        message: String(typed.message),
      },
    };
  }
  return {
    ok: false,
    error: {
      code: 'GUEST_ERROR',
      message: error instanceof Error ? error.message : String(error),
    },
  };
}

function registerGuestTool<M extends GuestMethod>(
  registry: ToolRegistry,
  guest: GuestTransport,
  method: M,
): void {
  const inputSchema = guestMethodSchemas[method] as unknown as z.ZodType<GuestMethodParams[M]>;
  registry.register({
    name: method,
    description: TOOL_DESCRIPTIONS[method] ?? `Invoke guest method ${method}.`,
    inputSchema,
    execute: async (input, context) => {
      try {
        const data = await guest.request(method, input as GuestMethodParams[M], {
          signal: context.signal,
        });
        return { ok: true, data };
      } catch (error) {
        return transportFailure(error);
      }
    },
  });
}

/** Build the semantic guest tools used by both the real and mock transports. */
export function createGuestToolRegistry(
  guest: GuestTransport,
  options: ToolRegistryOptions = {},
): ToolRegistry {
  const registry = new ToolRegistry(options);
  for (const method of Object.keys(guestMethodSchemas) as GuestMethod[]) {
    registerGuestTool(registry, guest, method);
  }
  return registry;
}

export const createDefaultToolRegistry = createGuestToolRegistry;
