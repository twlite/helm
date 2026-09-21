import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuestRpcError } from "./errors";
import type { CommandExecutor } from "./commands";
import { BunCommandExecutor } from "./commands";

export interface DesktopWindow {
  id: string;
  windowId: string;
  application: string;
  className?: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
}

export interface DesktopState {
  display: string | null;
  focusedWindow?: DesktopWindow;
  windows: DesktopWindow[];
}

const KEY_ALIASES: Readonly<Record<string, string>> = {
  CTRL: "ctrl",
  CONTROL: "ctrl",
  ALT: "alt",
  SHIFT: "shift",
  META: "super",
  CMD: "super",
  COMMAND: "super",
  WIN: "super",
  WINDOWS: "super",
  ENTER: "Return",
  RETURN: "Return",
  ESC: "Escape",
  ESCAPE: "Escape",
  TAB: "Tab",
  SPACE: "space",
  BACKSPACE: "BackSpace",
  DELETE: "Delete",
  INSERT: "Insert",
  HOME: "Home",
  END: "End",
  PAGEUP: "Prior",
  PAGEDOWN: "Next",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
};

function parseWindowLine(line: string): DesktopWindow | undefined {
  const fields = line.trim().split(/\s+/);
  // wmctrl -lGx: id desktop x y width height host WM_CLASS title...
  if (fields.length < 8) return undefined;

  const [id, _desktop, x, y, width, height, host, className, ...titleParts] = fields;
  if (
    id === undefined ||
    x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined ||
    className === undefined ||
    host === undefined
  ) {
    return undefined;
  }

  const numeric = [x, y, width, height].map(Number);
  if (numeric.some((value) => !Number.isFinite(value))) return undefined;

  const application = className.split(".").at(-1) ?? className;
  return {
    id,
    windowId: id,
    application: host === "-" ? application : application || host,
    className,
    title: titleParts.join(" "),
    x: numeric[0] ?? 0,
    y: numeric[1] ?? 0,
    width: numeric[2] ?? 0,
    height: numeric[3] ?? 0,
    focused: false,
  };
}

function commandFailure(
  command: string,
  stderr: string,
): GuestRpcError {
  return new GuestRpcError(
    "DESKTOP_COMMAND_FAILED",
    `${command} failed${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : "."}`,
  );
}

export class DesktopController {
  constructor(
    private readonly commands: CommandExecutor = new BunCommandExecutor(),
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  async listWindows(): Promise<{ windows: DesktopWindow[] }> {
    const result = await this.commands.run("wmctrl", ["-lGx"]);
    if (result.exitCode !== 0) throw commandFailure("wmctrl", result.stderr);

    const windows = result.stdout
      .split(/\r?\n/)
      .map(parseWindowLine)
      .filter((window): window is DesktopWindow => window !== undefined);
    const focusedId = await this.activeWindowId();
    for (const window of windows) {
      window.focused = focusedId === window.id;
    }
    return { windows };
  }

  async getState(): Promise<DesktopState> {
    const { windows } = await this.listWindows();
    const focusedWindow = windows.find((window) => window.focused);
    return {
      display: this.environment.DISPLAY ?? null,
      ...(focusedWindow === undefined ? {} : { focusedWindow }),
      windows,
    };
  }

  async focusWindow(input: {
    windowId?: string;
    application?: string;
    titleIncludes?: string;
  }): Promise<{ focusedWindow: DesktopWindow; windows: DesktopWindow[] }> {
    const { windows } = await this.listWindows();
    const match = windows.find((window) => {
      if (input.windowId !== undefined && window.id !== input.windowId) return false;
      if (
        input.application !== undefined &&
        !window.application.toLowerCase().includes(input.application.toLowerCase())
      ) {
        return false;
      }
      if (
        input.titleIncludes !== undefined &&
        !window.title.toLowerCase().includes(input.titleIncludes.toLowerCase())
      ) {
        return false;
      }
      return true;
    });

    if (match === undefined) {
      throw new GuestRpcError("WINDOW_NOT_FOUND", "No matching desktop window was found.");
    }

    const result = await this.commands.run("wmctrl", ["-ia", match.id]);
    if (result.exitCode !== 0) throw commandFailure("wmctrl", result.stderr);
    return {
      focusedWindow: { ...match, focused: true },
      windows: windows.map((window) => ({ ...window, focused: window.id === match.id })),
    };
  }

  async hotkey(keys: readonly string[]): Promise<{ keys: string[]; sent: true }> {
    if (keys.length === 0 || keys.length > 8) {
      throw new GuestRpcError("INVALID_PARAMS", "keys must contain between one and eight keys.", {
        httpStatus: 400,
      });
    }

    const normalized = keys.map((key) => this.normalizeKey(key));
    const result = await this.commands.run("xdotool", ["key", "--clearmodifiers", ...normalized]);
    if (result.exitCode !== 0) throw commandFailure("xdotool", result.stderr);
    return { keys: normalized, sent: true };
  }

  async type(text: string): Promise<{ text: string; typed: true }> {
    const result = await this.commands.run("xdotool", ["type", "--delay", "1", text]);
    if (result.exitCode !== 0) throw commandFailure("xdotool", result.stderr);
    return { text, typed: true };
  }

  async click(input: {
    x: number;
    y: number;
    button?: number;
  }): Promise<{ x: number; y: number; clicked: true; button: number }> {
    const button = input.button ?? 1;
    if (!Number.isInteger(button) || button < 1 || button > 5) {
      throw new GuestRpcError("INVALID_PARAMS", "button must be an integer from 1 to 5.", {
        httpStatus: 400,
      });
    }
    const x = Math.round(input.x);
    const y = Math.round(input.y);
    const result = await this.commands.run("xdotool", [
      "mousemove",
      "--sync",
      String(x),
      String(y),
      "click",
      String(button),
    ]);
    if (result.exitCode !== 0) throw commandFailure("xdotool", result.stderr);
    return { x, y, clicked: true, button };
  }

  async screenshot(): Promise<{
    screenshotId: string;
    image: string;
    mimeType: "image/png";
    base64: string;
    byteLength: number;
  }> {
    const path = join(tmpdir(), `helm-guest-${crypto.randomUUID()}.png`);
    const attempts: ReadonlyArray<readonly ["gnome-screenshot" | "scrot" | "maim", readonly string[]]> = [
      ["gnome-screenshot", ["-f", path]],
      ["scrot", [path]],
      ["maim", [path]],
    ];

    try {
      for (const [command, args] of attempts) {
        try {
          const result = await this.commands.run(command, args);
          if (result.exitCode !== 0) continue;
          const image = await readFile(path);
          const base64 = image.toString("base64");
          return {
            screenshotId: `desktop-${crypto.randomUUID()}`,
            image: `data:image/png;base64,${base64}`,
            mimeType: "image/png",
            base64,
            byteLength: image.byteLength,
          };
        } catch (error) {
          if (error instanceof GuestRpcError && error.code === "COMMAND_UNAVAILABLE") {
            continue;
          }
          throw error;
        }
      }
    } finally {
      await unlink(path).catch(() => undefined);
    }

    throw new GuestRpcError(
      "DESKTOP_SCREENSHOT_UNAVAILABLE",
      "No allowlisted screenshot utility produced an image.",
    );
  }

  async diagnostics(): Promise<{
    display: string | null;
    wmctrl: boolean;
    xdotool: boolean;
    screenshot: boolean;
  }> {
    const [wmctrl, xdotool, gnomeScreenshot, scrot, maim] = await Promise.all([
      this.commands.available("wmctrl"),
      this.commands.available("xdotool"),
      this.commands.available("gnome-screenshot"),
      this.commands.available("scrot"),
      this.commands.available("maim"),
    ]);
    return {
      display: this.environment.DISPLAY ?? null,
      wmctrl,
      xdotool,
      screenshot: gnomeScreenshot || scrot || maim,
    };
  }

  private async activeWindowId(): Promise<string | undefined> {
    try {
      const result = await this.commands.run("xdotool", ["getactivewindow"]);
      if (result.exitCode !== 0) return undefined;
      const id = result.stdout.trim();
      return id.length > 0 ? id : undefined;
    } catch (error) {
      if (error instanceof GuestRpcError && error.code === "COMMAND_UNAVAILABLE") {
        return undefined;
      }
      throw error;
    }
  }

  private normalizeKey(key: string): string {
    const normalizedInput = key.trim().toUpperCase();
    if (normalizedInput.length === 0) {
      throw new GuestRpcError("INVALID_PARAMS", "keys cannot contain empty values.", {
        httpStatus: 400,
      });
    }

    const alias = KEY_ALIASES[normalizedInput];
    if (alias !== undefined) return alias;
    if (/^[A-Z0-9]$/.test(normalizedInput)) return normalizedInput.toLowerCase();
    if (/^F(?:[1-9]|1[0-2])$/.test(normalizedInput)) return normalizedInput;

    throw new GuestRpcError(
      "INVALID_PARAMS",
      `Unsupported desktop key: ${key}.`,
      { httpStatus: 400 },
    );
  }
}
