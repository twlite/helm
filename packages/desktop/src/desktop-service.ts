import { KeyAlias, MouseButton } from './constants.js';
import { DesktopServiceError } from './errors.js';
import { execFile } from './exec-file.js';
import type {
  DesktopDisplayGeometry,
  DesktopApplication,
  DesktopControlMode,
  DesktopLaunchResult,
  DesktopShellCommandResult,
  DesktopScreenshotResult,
  DesktopServiceOptions,
  DesktopWindowInfo,
  ScreenSize,
  ScrollDirection,
} from './types.js';

const toErrorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class DesktopService {
  private readonly mode: DesktopControlMode;
  private readonly desktopContainer: string;
  private readonly display: string;
  private readonly timeoutMs: number;

  public constructor(options: DesktopServiceOptions = {}) {
    this.mode =
      options.mode ??
      (process.env.DESKTOP_CONTROL_MODE as DesktopControlMode | undefined) ??
      'docker-exec';
    this.desktopContainer =
      options.desktopContainer ??
      process.env.DESKTOP_CONTAINER ??
      'agent-desktop';
    this.display = options.display ?? process.env.DESKTOP_DISPLAY ?? ':99';
    this.timeoutMs =
      options.timeoutMs ??
      Number(process.env.DESKTOP_COMMAND_TIMEOUT_MS ?? 10_000);
  }

  public async moveMouse(x: number, y: number): Promise<void> {
    const { x: resolvedX, y: resolvedY } = await this.resolvePointWithinDisplay(
      x,
      y,
    );
    const targetX = String(resolvedX);
    const targetY = String(resolvedY);

    try {
      await this.runXdotool(
        ['mousemove', '--sync', targetX, targetY],
        'move mouse',
      );
    } catch {
      // Some desktop environments fail with --sync; fallback to plain move.
      await this.runXdotool(['mousemove', targetX, targetY], 'move mouse');
    }
  }

  private resolveMouseButton(button: MouseButton): string {
    for (const [key, value] of Object.entries(MouseButton)) {
      if (key.toLowerCase() === button.toLowerCase() || value === button) {
        return value;
      }

      if (!Number.isNaN(button) && value === button) {
        return value;
      }
    }

    throw new DesktopServiceError(`Invalid mouse button: ${button}`);
  }

  public async click(
    button: MouseButton = MouseButton.Left,
    repeat = 1,
  ): Promise<void> {
    const btn = this.resolveMouseButton(button);
    const safeRepeat = Math.max(1, Math.trunc(repeat));
    const delayMs = safeRepeat > 1 ? 180 : 90;
    await this.runXdotool(
      [
        'click',
        '--repeat',
        String(safeRepeat),
        '--delay',
        String(delayMs),
        btn,
      ],
      `${button} click`,
    );
  }

  public async dragMouseTo(x: number, y: number): Promise<void> {
    const { x: resolvedX, y: resolvedY } = await this.resolvePointWithinDisplay(
      x,
      y,
    );
    const targetX = String(resolvedX);
    const targetY = String(resolvedY);

    try {
      await this.runXdotool(
        [
          'mousedown',
          MouseButton.Left,
          'mousemove',
          '--sync',
          targetX,
          targetY,
          'mouseup',
          MouseButton.Left,
        ],
        'drag mouse',
      );
    } catch {
      await this.runXdotool(
        [
          'mousedown',
          MouseButton.Left,
          'mousemove',
          targetX,
          targetY,
          'mouseup',
          MouseButton.Left,
        ],
        'drag mouse',
      );
    }
  }

  public async launchApplication(
    app: DesktopApplication,
  ): Promise<DesktopLaunchResult> {
    const beforeWindows = await this.listWindows().catch(() => []);
    const existingWindow = this.findApplicationWindow(app, beforeWindows);

    if (existingWindow) {
      await this.activateWindow(existingWindow.id);
      // Settle so the X11 compositor redraws the focused window before any screenshot
      await new Promise((resolve) => setTimeout(resolve, 600));
      const windows = await this.listWindows().catch(() => beforeWindows);
      return {
        action: 'focused_existing',
        app,
        matchedWindow: existingWindow,
        windows,
      };
    }

    const commandByApp: Record<DesktopApplication, string> = {
      firefox: 'setsid firefox-esr about:blank >/tmp/helm-firefox-launch.log 2>&1 &',
      terminal: 'setsid lxterminal >/tmp/helm-terminal-launch.log 2>&1 &',
    };

    await this.runShell(commandByApp[app], `launch ${app}`);
    const matchedWindow = await this.pollForWindow(app);
    const windows = await this.listWindows().catch(() => beforeWindows);

    return {
      action: 'launched',
      app,
      matchedWindow,
      windows,
    };
  }

  /** Poll until the app window appears or timeout expires. */
  private async pollForWindow(
    app: DesktopApplication,
    timeoutMs = 8000,
    intervalMs = 500,
  ): Promise<DesktopWindowInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const windows = await this.listWindows().catch(() => []);
      const found = this.findApplicationWindow(app, windows);
      if (found) {
        // Extra settle so the window finishes rendering before a screenshot
        await new Promise((resolve) => setTimeout(resolve, 600));
        return found;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return undefined;
  }

  public async scroll(direction: ScrollDirection, amount = 1): Promise<void> {
    const button = direction === 'up' ? '4' : '5';
    const safeAmount = Math.max(1, Math.trunc(amount));
    await this.runXdotool(
      ['click', '--repeat', String(safeAmount), button],
      `scroll ${direction}`,
    );
  }

  public async pressKey(keyOrCombo: string): Promise<void> {
    await this.runXdotool(
      ['key', '--clearmodifiers', this.normalizeCombo(keyOrCombo)],
      `press key ${keyOrCombo}`,
    );
  }

  public async hotkey(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      throw new DesktopServiceError('hotkey requires at least one key');
    }
    const combo = keys.map((key) => this.normalizeKey(key)).join('+');
    await this.runXdotool(
      ['key', '--clearmodifiers', combo],
      `press hotkey ${combo}`,
    );
  }

  public async typeText(text: string, delayMs = 12): Promise<void> {
    await this.runXdotool(
      [
        'type',
        '--clearmodifiers',
        '--delay',
        String(Math.max(0, Math.trunc(delayMs))),
        text,
      ],
      'type text',
    );
  }

  public async getMouseLocation(): Promise<{
    x: number;
    y: number;
    screen: number;
    window: number;
  }> {
    const output = await this.runXdotool(
      ['getmouselocation', '--shell'],
      'get mouse location',
    );
    const values = Object.fromEntries(
      output
        .trim()
        .split('\n')
        .map((line) => line.split('='))
        .filter((pair) => pair.length === 2),
    );

    return {
      x: Number(values.X ?? 0),
      y: Number(values.Y ?? 0),
      screen: Number(values.SCREEN ?? 0),
      window: Number(values.WINDOW ?? 0),
    };
  }

  public async listWindows(): Promise<DesktopWindowInfo[]> {
    const output = await this.runXdotool(
      ['search', '--onlyvisible', '--name', '.*'],
      'list windows',
    );
    const ids = output
      .trim()
      .split('\n')
      .map((line) => Number(line.trim()))
      .filter((id) => Number.isFinite(id));

    const windows: DesktopWindowInfo[] = [];
    for (const id of ids.slice(0, 80)) {
      try {
        const name = (
          await this.runXdotool(['getwindowname', String(id)], 'get window name')
        ).trim();
        const className = (
          await this.runXdotool(
            ['getwindowclassname', String(id)],
            'get window class',
          ).catch(() => '')
        ).trim();
        windows.push({ className, id, name });
      } catch {
        windows.push({ id, name: '' });
      }
    }

    return windows;
  }

  private findApplicationWindow(
    app: DesktopApplication,
    windows: DesktopWindowInfo[],
  ): DesktopWindowInfo | undefined {
    const titleMatchers: Record<DesktopApplication, RegExp[]> = {
      firefox: [/firefox/i, /mozilla/i],
      terminal: [/terminal/i, /lxterminal/i, /^agent@[^:]+:/i],
    };

    return windows.find((window) =>
      titleMatchers[app].some((matcher) => {
        return matcher.test(window.name) || matcher.test(window.className ?? '');
      }),
    );
  }

  private async activateWindow(windowId: number): Promise<void> {
    const id = String(windowId);
    try {
      await this.runXdotool(['windowactivate', '--sync', id], 'activate window');
    } catch {
      await this.runXdotool(['windowactivate', id], 'activate window');
    }
  }

  public async screenshot(): Promise<DesktopScreenshotResult> {
    const command =
      'tmp="$(mktemp /tmp/helm-screen-XXXXXX.png)" && rm -f "$tmp" && (scrot -p "$tmp" 2>/dev/null || scrot "$tmp" 2>/dev/null || import -window root "$tmp" 2>/dev/null || true) && [ -s "$tmp" ] && base64 -w 0 "$tmp"; rm -f "$tmp"';

    try {
      if (this.mode === 'local') {
        const { stdout } = await execFile('sh', ['-lc', command], {
          timeout: this.timeoutMs,
          env: { ...process.env, DISPLAY: this.display },
        });

        return {
          pngBase64: stdout.trim(),
          mimeType: 'image/png',
        };
      }

      const { stdout } = await execFile(
        'docker',
        [
          'exec',
          this.desktopContainer,
          'env',
          `DISPLAY=${this.display}`,
          'sh',
          '-lc',
          command,
        ],
        {
          timeout: this.timeoutMs,
        },
      );

      return {
        pngBase64: stdout.trim(),
        mimeType: 'image/png',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DesktopServiceError(
        `Failed to take screenshot: ${message}`,
        error,
      );
    }
  }

  public async screenshotDataUrl(): Promise<string> {
    const screenshot = await this.screenshot();
    return `data:${screenshot.mimeType};base64,${screenshot.pngBase64}`;
  }

  public async runShellCommand(
    command: string,
  ): Promise<DesktopShellCommandResult> {
    try {
      if (this.mode === 'local') {
        const { stderr, stdout } = await execFile('sh', ['-lc', command], {
          timeout: this.timeoutMs,
          env: { ...process.env, DISPLAY: this.display },
          cwd: process.env.HOME,
        });

        return {
          command,
          exitCode: 0,
          ok: true,
          stderr,
          stdout,
        };
      }

      const { stderr, stdout } = await execFile(
        'docker',
        [
          'exec',
          '--workdir',
          '/home/agent',
          this.desktopContainer,
          'env',
          'HOME=/home/agent',
          `DISPLAY=${this.display}`,
          'sh',
          '-lc',
          command,
        ],
        {
          timeout: this.timeoutMs,
        },
      );

      return {
        command,
        exitCode: 0,
        ok: true,
        stderr,
        stdout,
      };
    } catch (error) {
      const maybeError = error as {
        code?: number;
        stderr?: string;
        stdout?: string;
      };
      return {
        command,
        exitCode:
          typeof maybeError.code === 'number' ? maybeError.code : 1,
        ok: false,
        stderr: maybeError.stderr ?? toErrorText(error),
        stdout: maybeError.stdout ?? '',
      };
    }
  }

  public async getDisplayGeometry(): Promise<DesktopDisplayGeometry> {
    const output = await this.runXdotool(
      ['getdisplaygeometry'],
      'get display geometry',
    );

    const [widthText, heightText] = output.trim().split(/\s+/);
    const width = Number(widthText);
    const height = Number(heightText);

    if (!Number.isFinite(width) || !Number.isFinite(height)) {
      throw new DesktopServiceError(
        `Unexpected display geometry output: ${output.trim()}`,
      );
    }

    return { width, height };
  }

  public async getScreenSize(): Promise<ScreenSize> {
    const geometry = await this.getDisplayGeometry();
    return { width: geometry.width, height: geometry.height };
  }

  private normalizeCombo(combo: string): string {
    return combo
      .split('+')
      .map((token) => this.normalizeKey(token))
      .join('+');
  }

  private normalizeKey(key: string): string {
    const raw = key.trim();
    if (raw.length === 0) {
      throw new DesktopServiceError('Key cannot be empty');
    }

    const lower = raw.toLowerCase();
    return KeyAlias[lower] ?? raw;
  }

  private toFiniteInt(value: number, label: string): number {
    if (!Number.isFinite(value)) {
      throw new DesktopServiceError(`${label} must be a finite number`);
    }

    return Math.trunc(value);
  }

  private async resolvePointWithinDisplay(
    x: number,
    y: number,
  ): Promise<{ x: number; y: number }> {
    const rawX = this.toFiniteInt(x, 'x');
    const rawY = this.toFiniteInt(y, 'y');

    try {
      const geometry = await this.getDisplayGeometry();
      const maxX = Math.max(0, geometry.width - 1);
      const maxY = Math.max(0, geometry.height - 1);

      return {
        x: Math.min(maxX, Math.max(0, rawX)),
        y: Math.min(maxY, Math.max(0, rawY)),
      };
    } catch {
      // If geometry lookup fails, keep raw coordinates to avoid blocking actions.
      return { x: rawX, y: rawY };
    }
  }

  private async runXdotool(args: string[], action: string): Promise<string> {
    try {
      if (this.mode === 'local') {
        const { stdout } = await execFile('xdotool', args, {
          timeout: this.timeoutMs,
          env: { ...process.env, DISPLAY: this.display },
        });
        return stdout;
      }

      const { stdout } = await execFile(
        'docker',
        [
          'exec',
          this.desktopContainer,
          'env',
          `DISPLAY=${this.display}`,
          'xdotool',
          ...args,
        ],
        {
          timeout: this.timeoutMs,
        },
      );

      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DesktopServiceError(`Failed to ${action}: ${message}`, error);
    }
  }

  private async runShell(command: string, action: string): Promise<string> {
    try {
      if (this.mode === 'local') {
        const { stdout } = await execFile('sh', ['-lc', command], {
          timeout: this.timeoutMs,
          env: { ...process.env, DISPLAY: this.display },
        });
        return stdout;
      }

      const { stdout } = await execFile(
        'docker',
        [
          'exec',
          this.desktopContainer,
          'env',
          `DISPLAY=${this.display}`,
          'sh',
          '-lc',
          command,
        ],
        {
          timeout: this.timeoutMs,
        },
      );

      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new DesktopServiceError(`Failed to ${action}: ${message}`, error);
    }
  }
}
