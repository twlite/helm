import type { Hono } from 'hono';
import { desktopService } from '../desktop/desktop-service.ts';

export const registerDesktopRoutes = (app: Hono) => {
  app.get('/api/desktop/screenshot', async (c) => {
    try {
      const [screenshot, geometry, cursor] = await Promise.all([
        desktopService.screenshot(),
        desktopService.getDisplayGeometry().catch(() => null),
        desktopService.getMouseLocation().catch(() => null),
      ]);

      if (!screenshot.pngBase64.trim()) {
        return c.json(
          {
            error: {
              code: 'empty_screenshot',
              message: 'The desktop returned an empty screenshot.',
            },
          },
          503,
        );
      }

      return c.json({
        cursor,
        dataUrl: `data:${screenshot.mimeType};base64,${screenshot.pngBase64.trim()}`,
        filename: `desktop-screenshot-${Date.now()}.png`,
        geometry,
        mimeType: screenshot.mimeType,
      });
    } catch (error) {
      return c.json(
        {
          error: {
            code: 'desktop_unavailable',
            message:
              error instanceof Error
                ? error.message
                : 'The desktop screenshot could not be captured.',
          },
        },
        503,
      );
    }
  });
};
