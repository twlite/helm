import { DesktopService } from '@helm/desktop';

export const desktopService = new DesktopService();

export const takeDesktopScreenshot = () => desktopService.screenshot();

export const takeDesktopScreenshotDataUrl = () =>
  desktopService.screenshotDataUrl();

export const getDesktopScreenSize = () => desktopService.getScreenSize();
