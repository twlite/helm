import { ApplicationController, isGuestApplication, type GuestApplication } from "./apps";
import { BrowserController } from "./browser";
import { GuestRpcError, asGuestRpcError, errorPayload } from "./errors";
import { BunCommandExecutor, type CommandExecutor } from "./commands";
import { DesktopController } from "./desktop";
import {
  GUEST_METHODS,
  failureResponse,
  objectParams,
  optionalBoolean,
  optionalInteger,
  optionalString,
  parseGuestRequest,
  requiredFiniteNumber,
  requiredString,
  successResponse,
  type GuestRequest,
  type GuestResponse,
  requestIdOf,
  enumValue,
  optionalFiniteNumber,
} from "./protocol";
import { GuestSandbox } from "./sandbox";

export interface GuestRuntimeOptions {
  sandbox?: GuestSandbox;
  browser?: BrowserController;
  desktop?: DesktopController;
  commands?: CommandExecutor;
}

export interface GuestHealth {
  guest: true;
  sandbox: Awaited<ReturnType<GuestSandbox["diagnostics"]>>;
  browser: Awaited<ReturnType<BrowserController["diagnostics"]>>;
  desktop: Awaited<ReturnType<DesktopController["diagnostics"]>>;
}

export class GuestRuntime {
  readonly sandbox: GuestSandbox;
  readonly browser: BrowserController;
  readonly desktop: DesktopController;
  readonly apps: ApplicationController;

  constructor(options: GuestRuntimeOptions = {}) {
    const commands = options.commands ?? new BunCommandExecutor();
    this.sandbox = options.sandbox ?? new GuestSandbox();
    this.browser =
      options.browser ??
      new BrowserController(
        this.sandbox,
        process.env.HELM_CHROMIUM_PATH === undefined
          ? {}
          : { executablePath: process.env.HELM_CHROMIUM_PATH },
      );
    this.desktop = options.desktop ?? new DesktopController(commands);
    this.apps = new ApplicationController(this.sandbox, this.browser, commands);
  }

  async health(): Promise<GuestHealth> {
    const [sandbox, browser, desktop] = await Promise.all([
      this.sandbox.diagnostics(),
      this.browser.diagnostics(),
      this.desktop.diagnostics(),
    ]);
    return { guest: true, sandbox, browser, desktop };
  }

  async close(): Promise<void> {
    await this.browser.close();
  }

  async dispatch(value: unknown): Promise<GuestResponse> {
    const id = requestIdOf(value);
    let request: GuestRequest;
    try {
      request = parseGuestRequest(value);
    } catch (error) {
      return failureResponse(id, errorPayload(error));
    }

    try {
      const result = await this.execute(request);
      return successResponse(request.id, result);
    } catch (error) {
      const normalized = asGuestRpcError(error);
      return failureResponse(request.id, errorPayload(normalized));
    }
  }

  private async execute(request: GuestRequest): Promise<unknown> {
    const params = objectParams(request.params);
    switch (request.method) {
      case "guest.handshake":
        return {
          runtime: "helm-guest",
          protocolVersion: 1,
          methods: [...GUEST_METHODS],
          sandbox: {
            root: this.sandbox.rootPath,
            workspace: this.sandbox.workspacePath,
          },
        };
      case "fs.read":
        return this.sandbox.read(requiredString(params, "path", { maxLength: 16_384 }));
      case "fs.write":
        return this.sandbox.write(
          requiredString(params, "path", { maxLength: 16_384 }),
          requiredString(params, "content", { maxLength: 50 * 1024 * 1024 }),
        );
      case "fs.mkdir":
        return this.sandbox.mkdir(requiredString(params, "path", { maxLength: 16_384 }));
      case "fs.exists":
        return this.sandbox.exists(requiredString(params, "path", { maxLength: 16_384 }));
      case "fs.list":
        return this.sandbox.list(requiredString(params, "path", { maxLength: 16_384 }));
      case "fs.stat":
        return this.sandbox.stat(requiredString(params, "path", { maxLength: 16_384 }));
      case "browser.navigate":
        return this.browser.navigate(
          (() => {
            const timeoutMs = optionalInteger(params, "timeoutMs", {
              min: 100,
              max: 120_000,
            });
            return {
              url: requiredString(params, "url", { maxLength: 8_192 }),
              waitUntil: enumValue(
                params,
                "waitUntil",
                ["commit", "domcontentloaded", "load", "networkidle"] as const,
                "domcontentloaded",
              ),
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
            };
          })(),
        );
      case "browser.getState":
        return this.browser.getState();
      case "browser.snapshot":
        return this.browser.snapshot((() => {
          const maxRegions = optionalInteger(params, "maxRegions", { min: 1, max: 100 });
          return maxRegions === undefined ? {} : { maxRegions };
        })());
      case "browser.read": {
        const mode = enumValue(params, "mode", ["readable", "document"] as const, "readable");
        const ref = optionalString(params, "ref", { maxLength: 64 });
        const maxChars = optionalInteger(params, "maxChars", { min: 1, max: 12_000 });
        const cursor = optionalString(params, "cursor", { maxLength: 2_048 });
        return this.browser.read({
          mode,
          ...(ref === undefined ? {} : { ref }),
          ...(maxChars === undefined ? {} : { maxChars }),
          ...(cursor === undefined ? {} : { cursor }),
        });
      }
      case "browser.search": {
        const maxResults = optionalInteger(params, "maxResults", { min: 1, max: 20 });
        return this.browser.search({
          query: requiredString(params, "query", { maxLength: 1_000 }),
          ...(Array.isArray(params.kinds) ? { kinds: params.kinds as import("../../../packages/shared/src/types").BrowserRegionKind[] } : {}),
          ...(maxResults === undefined ? {} : { maxResults }),
        });
      }
      case "browser.inspectRegion":
        return this.browser.inspectRegion((() => {
          const maxChars = optionalInteger(params, "maxChars", { min: 1_000, max: 12_000 });
          const offset = optionalInteger(params, "offset", { min: 0, max: 1_000_000 });
          const limit = optionalInteger(params, "limit", { min: 1, max: 100 });
          return {
            ref: requiredString(params, "ref", { maxLength: 64 }),
            format: enumValue(params, "format", ["auto", "text", "table", "links"] as const, "auto"),
            ...(maxChars === undefined ? {} : { maxChars }),
            ...(offset === undefined ? {} : { offset }),
            ...(limit === undefined ? {} : { limit }),
          };
        })());
      case "browser.download":
        return this.browser.download((() => {
          const ref = optionalString(params, "ref", { maxLength: 64 });
          const url = optionalString(params, "url", { maxLength: 8_192 });
          return {
            ...(ref === undefined ? {} : { ref }),
            ...(url === undefined ? {} : { url }),
          };
        })());
      case "browser.click":
        return this.browserClick(params);
      case "browser.type":
        return this.browser.type(
          requiredString(params, "ref", { maxLength: 64 }),
          requiredString(params, "text", { maxLength: 1_000_000 }),
          optionalBoolean(params, "clear", true),
        );
      case "app.launch":
        return this.apps.launch(this.application(params));
      case "app.openFile": {
        const application = this.application(params, "text-editor");
        if (application === "browser") {
          throw new GuestRpcError(
            "APP_NOT_SUPPORTED",
            "browser cannot be used with app.openFile.",
            { httpStatus: 400 },
          );
        }
        return this.apps.openFile(
          requiredString(params, "path", { maxLength: 16_384 }),
          application,
        );
      }
      case "desktop.getState":
        return this.desktop.getState();
      case "desktop.listWindows":
        return this.desktop.listWindows();
      case "desktop.focusWindow":
        return this.desktop.focusWindow(
          (() => {
            const windowId = optionalString(params, "windowId", { maxLength: 128 });
            const application = optionalString(params, "application", { maxLength: 256 });
            const titleIncludes = optionalString(params, "titleIncludes", {
              maxLength: 512,
            });
            return {
              ...(windowId === undefined ? {} : { windowId }),
              ...(application === undefined ? {} : { application }),
              ...(titleIncludes === undefined ? {} : { titleIncludes }),
            };
          })(),
        );
      case "desktop.hotkey": {
        const rawKeys = params.keys;
        if (
          !Array.isArray(rawKeys) ||
          rawKeys.length === 0 ||
          rawKeys.length > 8 ||
          rawKeys.some((key) => typeof key !== "string")
        ) {
          throw new GuestRpcError("INVALID_PARAMS", "keys must be a non-empty string array.", {
            httpStatus: 400,
          });
        }
        return this.desktop.hotkey(rawKeys);
      }
      case "desktop.type":
        return this.desktop.type(requiredString(params, "text", { maxLength: 1_000_000 }));
      case "desktop.click":
        return this.desktop.click(
          (() => {
            const button = optionalInteger(params, "button", { min: 1, max: 5 });
            return {
              x: requiredFiniteNumber(params, "x", { min: 0, max: 20_000 }),
              y: requiredFiniteNumber(params, "y", { min: 0, max: 20_000 }),
              ...(button === undefined ? {} : { button }),
            };
          })(),
        );
      case "desktop.screenshot":
        return this.desktop.screenshot();
    }
  }

  private async browserClick(params: Record<string, unknown>): Promise<unknown> {
    const ref = optionalString(params, "ref", { maxLength: 64 });
    const x = optionalFiniteNumber(params, "x", { min: 0, max: 20_000 });
    const y = optionalFiniteNumber(params, "y", { min: 0, max: 20_000 });
    if (ref !== undefined) {
      if (x !== undefined || y !== undefined) {
        throw new GuestRpcError("INVALID_PARAMS", "Provide either ref or coordinates, not both.", {
          httpStatus: 400,
        });
      }
      return this.browser.click(ref);
    }
    if (x === undefined || y === undefined) {
      throw new GuestRpcError("INVALID_PARAMS", "Provide either ref or both x and y.", {
        httpStatus: 400,
      });
    }
    return this.browser.clickAt(x, y);
  }

  private application(
    params: Record<string, unknown>,
    fallback?: GuestApplication,
  ): GuestApplication {
    const raw = params.application ?? params.app ?? fallback;
    if (typeof raw !== "string" || !isGuestApplication(raw)) {
      throw new GuestRpcError(
        "INVALID_PARAMS",
        "application must be browser, text-editor, or file-manager.",
        { httpStatus: 400 },
      );
    }
    return raw;
  }
}
