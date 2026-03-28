import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  DesktopService,
  DesktopServiceError,
  type MouseButton,
  type ScrollDirection,
} from '@helm/desktop';

const app = new Hono();
const desktop = new DesktopService();

type DesktopActionRequest = {
  action: string;
  x?: number;
  y?: number;
  button?: MouseButton;
  direction?: ScrollDirection;
  amount?: number;
  text?: string;
  key?: string;
  keys?: string[];
  delayMs?: number;
};

const assertNumber = (value: unknown, name: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${name} must be a finite number`);
  }

  return value;
};

const assertString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }

  return value;
};

app.onError((err, c) => {
  if (err instanceof DesktopServiceError) {
    return c.json({ error: err.message }, 502);
  }

  return c.json({ error: err.message ?? 'Unexpected error' }, 400);
});

app.get('/', (c) => {
  return c.text('Hello Hono!');
});

app.get('/desktop/status', async (c) => {
  const location = await desktop.getMouseLocation();
  return c.json({ ok: true, location });
});

app.post('/desktop/mouse/move', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  const x = assertNumber(body.x, 'x');
  const y = assertNumber(body.y, 'y');

  await desktop.moveMouse(x, y);
  return c.json({ ok: true });
});

app.post('/desktop/mouse/click', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  const button = body.button ?? 'left';
  const repeat = body.amount ?? 1;

  await desktop.click(button, repeat);
  return c.json({ ok: true });
});

app.post('/desktop/mouse/drag', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  const x = assertNumber(body.x, 'x');
  const y = assertNumber(body.y, 'y');

  await desktop.dragMouseTo(x, y);
  return c.json({ ok: true });
});

app.post('/desktop/mouse/scroll', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  const direction = body.direction ?? 'down';
  const amount = body.amount ?? 1;

  await desktop.scroll(direction, amount);
  return c.json({ ok: true });
});

app.post('/desktop/keyboard/key', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  const key = assertString(body.key, 'key');

  await desktop.pressKey(key);
  return c.json({ ok: true });
});

app.post('/desktop/keyboard/hotkey', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  if (!Array.isArray(body.keys) || body.keys.length === 0) {
    throw new Error('keys must be a non-empty string array');
  }

  await desktop.hotkey(body.keys);
  return c.json({ ok: true });
});

app.post('/desktop/keyboard/type', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();
  const text = assertString(body.text, 'text');
  const delayMs = body.delayMs ?? 12;

  await desktop.typeText(text, delayMs);
  return c.json({ ok: true });
});

app.post('/desktop/action', async (c) => {
  const body = await c.req.json<DesktopActionRequest>();

  switch (body.action) {
    case 'mouse_move':
      await desktop.moveMouse(
        assertNumber(body.x, 'x'),
        assertNumber(body.y, 'y'),
      );
      return c.json({ ok: true });

    case 'left_click':
      await desktop.click('left');
      return c.json({ ok: true });

    case 'right_click':
      await desktop.click('right');
      return c.json({ ok: true });

    case 'double_click':
      await desktop.click('left', 2);
      return c.json({ ok: true });

    case 'scroll_up':
      await desktop.scroll('up', body.amount ?? 1);
      return c.json({ ok: true });

    case 'scroll_down':
      await desktop.scroll('down', body.amount ?? 1);
      return c.json({ ok: true });

    case 'left_click_drag':
      await desktop.dragMouseTo(
        assertNumber(body.x, 'x'),
        assertNumber(body.y, 'y'),
      );
      return c.json({ ok: true });

    case 'key':
      await desktop.pressKey(assertString(body.key, 'key'));
      return c.json({ ok: true });

    case 'type':
      await desktop.typeText(
        assertString(body.text, 'text'),
        body.delayMs ?? 12,
      );
      return c.json({ ok: true });

    default:
      throw new Error(`Unsupported action: ${body.action}`);
  }
});

serve(
  {
    fetch: app.fetch,
    port: 3000,
  },
  (info) => {
    console.log(`Server is running on http://localhost:${info.port}`);
  },
);
