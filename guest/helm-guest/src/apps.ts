import { GuestRpcError } from "./errors";
import type { BrowserController } from "./browser";
import type { CommandExecutor } from "./commands";
import { BunCommandExecutor } from "./commands";
import type { GuestSandbox } from "./sandbox";

export type GuestApplication = "browser" | "text-editor" | "file-manager";

const APPLICATIONS: readonly GuestApplication[] = [
  "browser",
  "text-editor",
  "file-manager",
];

export function isGuestApplication(value: string): value is GuestApplication {
  return APPLICATIONS.includes(value as GuestApplication);
}

export class ApplicationController {
  constructor(
    private readonly sandbox: GuestSandbox,
    private readonly browser: BrowserController,
    private readonly commands: CommandExecutor = new BunCommandExecutor(),
  ) {}

  async launch(application: GuestApplication): Promise<{
    application: GuestApplication;
    launched: true;
    title: string;
    pid?: number;
    browser?: Awaited<ReturnType<BrowserController["getState"]>>;
  }> {
    if (application === "browser") {
      const browser = await this.browser.start();
      return {
        application,
        launched: true,
        title: browser.title,
        browser,
      };
    }

    const result = await this.commands.spawn(application, []);
    return {
      application,
      launched: true,
      title: application,
      ...(result.pid === undefined ? {} : { pid: result.pid }),
    };
  }

  async openFile(
    path: string,
    application: Exclude<GuestApplication, "browser"> = "text-editor",
  ): Promise<{
    application: Exclude<GuestApplication, "browser">;
    path: string;
    launched: true;
    title: string;
    pid?: number;
  }> {
    const file = await this.sandbox.stat(path);
    if (!file.exists) {
      throw new GuestRpcError("FILE_NOT_FOUND", "The requested file does not exist.");
    }
    if (file.type !== "file") {
      throw new GuestRpcError("FILE_NOT_REGULAR", "Only regular files can be opened by app.openFile.");
    }

    const result = await this.commands.spawn(application, [file.path]);
    return {
      application,
      path: file.path,
      launched: true,
      title: file.path.split("/").at(-1) ?? file.path,
      ...(result.pid === undefined ? {} : { pid: result.pid }),
    };
  }
}
