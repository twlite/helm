export type DesktopControlMode = 'docker-exec' | 'local';
export type ScrollDirection = 'up' | 'down';

export interface DesktopServiceOptions {
  mode?: DesktopControlMode;
  desktopContainer?: string;
  display?: string;
  timeoutMs?: number;
}

export interface DesktopScreenshotResult {
  pngBase64: string;
  mimeType: 'image/png';
}

export interface DesktopDisplayGeometry {
  width: number;
  height: number;
}

export interface ScreenSize {
  width: number;
  height: number;
}

export type DesktopApplication = 'firefox' | 'terminal';

export interface DesktopWindowInfo {
  className?: string;
  id: number;
  name: string;
}

export interface DesktopLaunchResult {
  action: 'focused_existing' | 'launched';
  app: DesktopApplication;
  matchedWindow?: DesktopWindowInfo;
  windows: DesktopWindowInfo[];
}

export interface DesktopShellCommandResult {
  command: string;
  exitCode: number;
  ok: boolean;
  stderr: string;
  stdout: string;
}
