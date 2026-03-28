import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type DesktopControlMode = 'docker-exec' | 'local';

export type MouseButton = 'left' | 'middle' | 'right';
export type ScrollDirection = 'up' | 'down';

const MOUSE_BUTTON: Record<MouseButton, string> = {
  left: '1',
  middle: '2',
  right: '3',
};

const KEY_ALIASES: Record<string, string> = {
  command: 'super',
  cmd: 'super',
  meta: 'super',
  win: 'super',
  windows: 'super',
  option: 'alt',
  control: 'ctrl',
  return: 'Return',
  enter: 'Return',
  esc: 'Escape',
  pgup: 'Page_Up',
  pgdn: 'Page_Down',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
};

export class DesktopServiceError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'DesktopServiceError';
  }
}

export interface DesktopServiceOptions {
  mode?: DesktopControlMode;
  desktopContainer?: string;
  display?: string;
  timeoutMs?: number;
}

export class DesktopService {
  private readonly mode: DesktopControlMode;
  private readonly desktopContainer: string;
  private readonly display: string;
  private readonly timeoutMs: number;

  constructor(options: DesktopServiceOptions = {}) {
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

  async moveMouse(x: number, y: number): Promise<void> {
    await this.runXdotool(
      ['mousemove', '--sync', String(Math.trunc(x)), String(Math.trunc(y))],
      'move mouse',
    );
  }

  async click(button: MouseButton = 'left', repeat = 1): Promise<void> {
    const btn = MOUSE_BUTTON[button];
    const safeRepeat = Math.max(1, Math.trunc(repeat));
    await this.runXdotool(
      ['click', '--repeat', String(safeRepeat), '--delay', '90', btn],
      `${button} click`,
    );
  }

  async dragMouseTo(x: number, y: number): Promise<void> {
    await this.runXdotool(
      [
        'mousedown',
        MOUSE_BUTTON.left,
        'mousemove',
        '--sync',
        String(Math.trunc(x)),
        String(Math.trunc(y)),
        'mouseup',
        MOUSE_BUTTON.left,
      ],
      'drag mouse',
    );
  }

  async scroll(direction: ScrollDirection, amount = 1): Promise<void> {
    const button = direction === 'up' ? '4' : '5';
    const safeAmount = Math.max(1, Math.trunc(amount));
    await this.runXdotool(
      ['click', '--repeat', String(safeAmount), button],
      `scroll ${direction}`,
    );
  }

  async pressKey(keyOrCombo: string): Promise<void> {
    await this.runXdotool(
      ['key', '--clearmodifiers', this.normalizeCombo(keyOrCombo)],
      `press key ${keyOrCombo}`,
    );
  }

  async hotkey(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      throw new DesktopServiceError('hotkey requires at least one key');
    }
    const combo = keys.map((key) => this.normalizeKey(key)).join('+');
    await this.runXdotool(
      ['key', '--clearmodifiers', combo],
      `press hotkey ${combo}`,
    );
  }

  async typeText(text: string, delayMs = 12): Promise<void> {
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

  async getMouseLocation(): Promise<{
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
    return KEY_ALIASES[lower] ?? raw;
  }

  private async runXdotool(args: string[], action: string): Promise<string> {
    try {
      if (this.mode === 'local') {
        const { stdout } = await execFileAsync('xdotool', args, {
          timeout: this.timeoutMs,
          env: { ...process.env, DISPLAY: this.display },
        });
        return stdout;
      }

      const { stdout } = await execFileAsync(
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
}
