import { GuestRpcError } from "./errors";
import type { GuestSandbox } from "./sandbox";

type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

interface PlaywrightLocator {
  click(options?: { timeout?: number }): Promise<void>;
  fill(value: string, options?: { timeout?: number }): Promise<void>;
  pressSequentially(value: string, options?: { timeout?: number }): Promise<void>;
  nth(index: number): PlaywrightLocator;
  evaluateAll<T>(pageFunction: (elements: readonly unknown[]) => T): Promise<T>;
}

interface PlaywrightPage {
  goto(
    url: string,
    options?: { waitUntil?: WaitUntil; timeout?: number },
  ): Promise<unknown>;
  title(): Promise<string>;
  url(): string;
  locator(selector: string): PlaywrightLocator;
  mouse: { click(x: number, y: number): Promise<void> };
  on(event: string, listener: (...args: unknown[]) => void): void;
  waitForLoadState(state?: WaitUntil, options?: { timeout?: number }): Promise<void>;
  close(): Promise<void>;
}

interface PlaywrightContext {
  pages(): PlaywrightPage[];
  newPage(): Promise<PlaywrightPage>;
  close(): Promise<void>;
}

interface PlaywrightChromium {
  launchPersistentContext(
    userDataDir: string,
    options: {
      headless: false;
      viewport: null;
      executablePath?: string;
      args?: readonly string[];
    },
  ): Promise<PlaywrightContext>;
}

interface PlaywrightModule {
  chromium: PlaywrightChromium;
}

interface SemanticElement {
  index: number;
  role: string;
  name: string;
  value?: string;
  text?: string;
  enabled: boolean;
}

export interface BrowserState {
  ready: boolean;
  visible: true;
  url: string;
  title: string;
  loading: boolean;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  elements: Array<{
    ref: string;
    role: string;
    name: string;
    value?: string;
    text?: string;
    enabled: boolean;
  }>;
}

const INTERACTIVE_SELECTOR =
  "button, input, textarea, select, a[href], summary, [role], [contenteditable='true']";

let playwrightModule: Promise<PlaywrightModule> | undefined;

async function loadPlaywright(): Promise<PlaywrightModule> {
  if (playwrightModule !== undefined) return playwrightModule;

  playwrightModule = (async () => {
    try {
      // Playwright is an optional runtime dependency in development. It is
      // intentionally kept external because the browser binary is provisioned
      // in the guest image, while this server bundle is injected separately.
      const imported = await import("playwright");
      const module = imported as unknown as PlaywrightModule;
      if (module.chromium === undefined) {
        throw new Error("Playwright chromium export is unavailable.");
      }
      return module;
    } catch {
      throw new GuestRpcError(
        "PLAYWRIGHT_UNAVAILABLE",
        "Playwright is not installed in the guest runtime.",
      );
    }
  })();

  return playwrightModule;
}

function safeUrl(value: string): string {
  if (value.length > 8_192 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new GuestRpcError("INVALID_PARAMS", "url is too long or contains control characters.", {
      httpStatus: 400,
    });
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:", "file:", "about:"].includes(parsed.protocol)) {
      throw new Error("unsupported protocol");
    }
  } catch {
    throw new GuestRpcError("INVALID_PARAMS", "url must be a valid http, https, file, or about URL.", {
      httpStatus: 400,
    });
  }
  return value;
}

function browserLaunchError(error: unknown): GuestRpcError {
  const message = error instanceof Error ? error.message.slice(0, 1_000) : "Visible Chromium could not be started.";
  if (/Executable doesn't exist at|playwright install/iu.test(message)) {
    return new GuestRpcError(
      "PLAYWRIGHT_BROWSER_MISSING",
      "Playwright Chromium is not installed in the guest. As the helm user, run `npx playwright install --with-deps chromium` (or `bunx --bun playwright install --with-deps chromium`), then restart helm-guest.",
      {
        details: {
          installCommand: "npx playwright install --with-deps chromium",
          originalMessage: message,
        },
      },
    );
  }
  return new GuestRpcError("BROWSER_START_FAILED", message);
}

export class BrowserController {
  private context: PlaywrightContext | undefined;
  private page: PlaywrightPage | undefined;
  private loading = false;
  private referenceRevision = 0;
  private referenceUrl = "";
  private references = new Map<string, { locator: PlaywrightLocator; revision: number; url: string }>();

  constructor(
    private readonly sandbox: GuestSandbox,
    private readonly options: {
      profilePath?: string;
      executablePath?: string;
      extraArgs?: readonly string[];
    } = {},
  ) {}

  async start(): Promise<BrowserState> {
    await this.ensurePage();
    return this.getState();
  }

  async navigate(input: {
    url: string;
    waitUntil?: WaitUntil;
    timeoutMs?: number;
  }): Promise<BrowserState> {
    const page = await this.ensurePage();
    const url = safeUrl(input.url);
    const waitUntil = input.waitUntil ?? "domcontentloaded";
    const timeoutMs = input.timeoutMs ?? 30_000;
    this.loading = true;

    try {
      await page.goto(url, { waitUntil, timeout: timeoutMs });
      this.loading = false;
      await this.readTitle(page);
      return await this.getState();
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_NAVIGATION_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The page could not be loaded.",
        { details: await this.stateWithoutThrowing(page) },
      );
    } finally {
      this.loading = false;
      this.invalidateReferences();
    }
  }

  async getState(): Promise<BrowserState> {
    const page = await this.ensurePage();
    return {
      ready: true,
      visible: true,
      url: page.url(),
      title: await this.readTitle(page),
      loading: this.loading,
    };
  }

  async snapshot(): Promise<BrowserSnapshot> {
    const page = await this.ensurePage();
    const url = page.url();
    const title = await this.readTitle(page);
    const candidates = page.locator(INTERACTIVE_SELECTOR);
    let elements: SemanticElement[];
    try {
      elements = await candidates.evaluateAll((nodes) =>
        nodes.flatMap((node, index) => {
          if (!(node instanceof HTMLElement)) return [];
          const style = window.getComputedStyle(node);
          const rect = node.getBoundingClientRect();
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            rect.width === 0 ||
            rect.height === 0
          ) {
            return [];
          }

          const explicitRole = node.getAttribute("role")?.trim();
          const tag = node.tagName.toLowerCase();
          const inputType =
            node instanceof HTMLInputElement ? node.type.toLowerCase() : undefined;
          const role =
            explicitRole ??
            (tag === "a"
              ? "link"
              : tag === "button"
                ? "button"
                : tag === "textarea"
                  ? "textbox"
                  : tag === "select"
                    ? "combobox"
                    : inputType === "checkbox"
                      ? "checkbox"
                      : inputType === "radio"
                        ? "radio"
                        : "textbox");

          const labelledBy = node.getAttribute("aria-labelledby");
          const labelledByText = labelledBy
            ?.split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent ?? "")
            .join(" ");
          const label =
            node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
              ? node.labels?.[0]?.textContent
              : undefined;
          const name =
            node.getAttribute("aria-label") ??
            labelledByText ??
            label ??
            node.getAttribute("placeholder") ??
            node.getAttribute("title") ??
            node.textContent ??
            "";
          const value =
            node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement || node instanceof HTMLSelectElement
              ? node.value
              : undefined;
          const rawText = node.textContent?.replace(/\s+/g, " ").trim();
          const text =
            rawText === undefined || rawText.length === 0
              ? undefined
              : rawText.length > 240
                ? `${rawText.slice(0, 239)}…`
                : rawText;
          const cleanName = name.replace(/\s+/g, " ").trim();
          const boundedName =
            cleanName.length > 160 ? `${cleanName.slice(0, 159)}…` : cleanName;
          const disabled =
            (node instanceof HTMLButtonElement ||
              node instanceof HTMLInputElement ||
              node instanceof HTMLTextAreaElement ||
              node instanceof HTMLSelectElement) &&
            node.disabled;

          return [
            {
              index,
              role,
              name: boundedName.length === 0 ? role : boundedName,
              ...(value === undefined || value.length === 0 ? {} : { value: value.slice(0, 240) }),
              ...(text === undefined ? {} : { text }),
              enabled: !disabled && node.getAttribute("aria-disabled") !== "true",
            },
          ];
        }),
      );
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_SNAPSHOT_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "Could not inspect the page.",
      );
    }

    this.invalidateReferences();
    this.referenceUrl = url;
    const output: BrowserSnapshot["elements"] = [];
    for (const [position, element] of elements.entries()) {
      const ref = `e${position + 1}`;
      this.references.set(ref, {
        locator: candidates.nth(element.index),
        revision: this.referenceRevision,
        url,
      });
      output.push({
        ref,
        role: element.role,
        name: element.name,
        ...(element.value === undefined ? {} : { value: element.value }),
        ...(element.text === undefined ? {} : { text: element.text }),
        enabled: element.enabled,
      });
    }

    return { url, title, elements: output };
  }

  async extractText(maxChars = 100_000): Promise<{
    text: string;
    truncated: boolean;
    url: string;
    title: string;
  }> {
    const page = await this.ensurePage();
    const body = page.locator("body");
    let text: string;
    try {
      text = await body.evaluateAll((nodes) => {
        const bodyNode = nodes[0];
        return bodyNode instanceof HTMLElement ? bodyNode.innerText : "";
      });
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_TEXT_EXTRACTION_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "Could not extract page text.",
      );
    }

    const normalized = text.replace(/\r\n/g, "\n").trim();
    return {
      text: normalized.slice(0, maxChars),
      truncated: normalized.length > maxChars,
      url: page.url(),
      title: await this.readTitle(page),
    };
  }

  async click(ref: string): Promise<BrowserState> {
    const locator = this.resolveReference(ref);
    try {
      await locator.click({ timeout: 15_000 });
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_CLICK_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser element could not be clicked.",
      );
    } finally {
      this.invalidateReferences();
    }
    return this.getState();
  }

  async clickAt(x: number, y: number): Promise<BrowserState> {
    const page = await this.ensurePage();
    try {
      await page.mouse.click(x, y);
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_CLICK_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser coordinate could not be clicked.",
      );
    } finally {
      this.invalidateReferences();
    }
    return this.getState();
  }

  async type(ref: string, text: string, clear: boolean): Promise<BrowserState> {
    const locator = this.resolveReference(ref);
    try {
      if (clear) {
        await locator.fill(text, { timeout: 15_000 });
      } else {
        await locator.pressSequentially(text, { timeout: 15_000 });
      }
    } catch (error) {
      throw new GuestRpcError(
        "BROWSER_TYPE_FAILED",
        error instanceof Error ? error.message.slice(0, 500) : "The browser element could not receive text.",
      );
    } finally {
      this.invalidateReferences();
    }
    return this.getState();
  }

  async diagnostics(): Promise<{ playwright: boolean; ready: boolean; visible: true }> {
    let playwright = false;
    try {
      await loadPlaywright();
      playwright = true;
    } catch (error) {
      if (!(error instanceof GuestRpcError) || error.code !== "PLAYWRIGHT_UNAVAILABLE") throw error;
    }
    return { playwright, ready: this.context !== undefined, visible: true };
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    this.page = undefined;
    this.invalidateReferences();
    if (context !== undefined) {
      await context.close().catch(() => undefined);
    }
  }

  private async ensurePage(): Promise<PlaywrightPage> {
    if (this.context !== undefined && this.page !== undefined) {
      return this.page;
    }

    const module = await loadPlaywright();
    const profile = await this.sandbox.ensureDirectory(
      this.options.profilePath ?? ".config/helm-chromium",
    );
    const contextOptions: {
      headless: false;
      viewport: null;
      executablePath?: string;
      args?: readonly string[];
    } = {
      headless: false,
      viewport: null,
    };
    const executablePath = this.options.executablePath ?? process.env.HELM_CHROMIUM_PATH;
    if (executablePath !== undefined && executablePath.length > 0) {
      contextOptions.executablePath = executablePath;
    }
    if (this.options.extraArgs !== undefined) {
      contextOptions.args = this.options.extraArgs;
    }

    try {
      this.context = await module.chromium.launchPersistentContext(profile, contextOptions);
      this.page = this.context.pages()[0] ?? (await this.context.newPage());
      this.page.on("framenavigated", () => this.invalidateReferences());
      this.page.on("load", () => {
        this.loading = false;
        this.invalidateReferences();
      });
      return this.page;
    } catch (error) {
      this.context = undefined;
      this.page = undefined;
      throw browserLaunchError(error);
    }
  }

  private resolveReference(ref: string): PlaywrightLocator {
    const entry = this.references.get(ref);
    if (entry === undefined) {
      throw new GuestRpcError("STALE_ELEMENT_REF", `Unknown or expired browser ref: ${ref}.`, {
        httpStatus: 400,
      });
    }
    const currentUrl = this.page?.url() ?? "";
    if (entry.revision !== this.referenceRevision || entry.url !== currentUrl) {
      this.references.delete(ref);
      throw new GuestRpcError("STALE_ELEMENT_REF", `Browser ref ${ref} is no longer valid.`, {
        httpStatus: 409,
      });
    }
    return entry.locator;
  }

  private invalidateReferences(): void {
    this.referenceRevision += 1;
    this.references.clear();
  }

  private async readTitle(page: PlaywrightPage): Promise<string> {
    try {
      return (await page.title()).slice(0, 1_000);
    } catch {
      return "";
    }
  }

  private async stateWithoutThrowing(page: PlaywrightPage): Promise<BrowserState> {
    return {
      ready: true,
      visible: true,
      url: page.url(),
      title: await this.readTitle(page),
      loading: this.loading,
    };
  }
}

function cleanTextForSnapshot(value: string | null | undefined, maxLength = 240): string | undefined {
  const text = value?.replace(/\s+/g, " ").trim();
  if (text === undefined || text.length === 0) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}
