import {
  access,
  constants,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { GuestRpcError } from "./errors";

export interface SandboxOptions {
  root?: string;
  workspace?: string;
  maxReadBytes?: number;
  maxWriteBytes?: number;
}

export interface FileReadResult {
  path: string;
  content: string;
  size: number;
}

export interface FileWriteResult {
  path: string;
  size: number;
  sha256: string;
  existedBefore: boolean;
  beforeSha256?: string;
  changed: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: "file" | "directory" | "symlink" | "other";
}

export interface FileStatResult {
  path: string;
  exists: boolean;
  type: "file" | "directory" | "other" | "missing";
  size: number;
  modifiedAt?: string;
}

function pathIsWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

function classifyMode(value: {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}): FileEntry["kind"] {
  if (value.isFile()) return "file";
  if (value.isDirectory()) return "directory";
  if (value.isSymbolicLink()) return "symlink";
  return "other";
}

function numericEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export class GuestSandbox {
  readonly rootPath: string;
  readonly workspacePath: string;
  readonly maxReadBytes: number;
  readonly maxWriteBytes: number;

  private rootRealPath: string | undefined;

  constructor(options: SandboxOptions = {}) {
    const root = resolve(options.root ?? process.env.HELM_GUEST_ROOT ?? "/home/helm");
    const workspace = resolve(
      options.workspace ?? process.env.HELM_GUEST_WORKSPACE ?? join(root, "workspace"),
    );

    if (!pathIsWithin(root, workspace)) {
      throw new GuestRpcError(
        "SANDBOX_CONFIGURATION_INVALID",
        "The guest workspace must be inside the guest sandbox root.",
        { httpStatus: 500 },
      );
    }

    this.rootPath = root;
    this.workspacePath = workspace;
    this.maxReadBytes = options.maxReadBytes ?? numericEnv("HELM_GUEST_MAX_READ_BYTES", 10 * 1024 * 1024);
    this.maxWriteBytes = options.maxWriteBytes ?? numericEnv("HELM_GUEST_MAX_WRITE_BYTES", 10 * 1024 * 1024);
  }

  async read(inputPath: string): Promise<FileReadResult> {
    const target = await this.existingPath(inputPath);
    const metadata = await stat(target);
    if (!metadata.isFile()) {
      throw new GuestRpcError("FILE_NOT_REGULAR", "The requested path is not a regular file.");
    }

    if (metadata.size > this.maxReadBytes) {
      throw new GuestRpcError(
        "FILE_TOO_LARGE",
        `The file is larger than the ${this.maxReadBytes}-byte read limit.`,
      );
    }

    try {
      const text = await readFile(target, "utf8");
      return {
        path: target,
        content: text,
        size: Buffer.byteLength(text, "utf8"),
      };
    } catch (error) {
      throw this.fileError(error, "FILE_READ_FAILED", `Could not read ${target}.`);
    }
  }

  async write(inputPath: string, content: string): Promise<FileWriteResult> {
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.maxWriteBytes) {
      throw new GuestRpcError(
        "FILE_TOO_LARGE",
        `The content is larger than the ${this.maxWriteBytes}-byte write limit.`,
      );
    }

    const target = await this.writablePath(inputPath);
    let existedBefore = false;
    let beforeSha256: string | undefined;
    try {
      const metadata = await lstat(target);
      existedBefore = true;
      if (metadata.isFile()) {
        const previous = await readFile(target);
        beforeSha256 = createHash("sha256").update(previous).digest("hex");
      }
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }
    try {
      await writeFile(target, content, { encoding: "utf8", flag: "w" });
      const sha256 = createHash("sha256").update(content, "utf8").digest("hex");
      return {
        path: target,
        size: bytes,
        sha256,
        existedBefore,
        ...(beforeSha256 === undefined ? {} : { beforeSha256 }),
        changed: !existedBefore || beforeSha256 === undefined || beforeSha256 !== sha256,
      };
    } catch (error) {
      throw this.fileError(error, "FILE_WRITE_FAILED", `Could not write ${target}.`);
    }
  }

  async mkdir(inputPath: string): Promise<{ path: string; existedBefore: boolean; changed: boolean }> {
    const target = this.lexicalPath(inputPath);
    await this.assertLexicallyInside(target);
    await this.assertExistingParentInside(target);

    let existedBefore = false;
    try {
      const metadata = await lstat(target);
      if (!metadata.isDirectory()) {
        throw new GuestRpcError("NOT_A_DIRECTORY", `${target} is not a directory.`);
      }
      existedBefore = true;
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }

    try {
      await mkdir(target, { recursive: true });
      await this.assertExistingTargetInside(target);
      return { path: target, existedBefore, changed: !existedBefore };
    } catch (error) {
      throw this.fileError(error, "DIRECTORY_CREATE_FAILED", `Could not create ${target}.`);
    }
  }

  async exists(inputPath: string): Promise<{ path: string; exists: boolean }> {
    const target = this.lexicalPath(inputPath);
    await this.assertLexicallyInside(target);
    await this.assertExistingParentInside(target);

    try {
      await lstat(target);
      await this.assertExistingTargetInside(target);
      return { path: target, exists: true };
    } catch (error) {
      if (this.isMissing(error)) {
        return { path: target, exists: false };
      }
      throw error;
    }
  }

  async list(inputPath: string): Promise<{ path: string; entries: string[] }> {
    const target = await this.existingPath(inputPath);
    const metadata = await stat(target);
    if (!metadata.isDirectory()) {
      throw new GuestRpcError("NOT_A_DIRECTORY", `${target} is not a directory.`);
    }

    try {
      const directoryEntries = await readdir(target, { withFileTypes: true });
      const entries = directoryEntries.map((entry) => entry.name);
      entries.sort((left, right) => left.localeCompare(right));
      return { path: target, entries };
    } catch (error) {
      throw this.fileError(error, "DIRECTORY_READ_FAILED", `Could not list ${target}.`);
    }
  }

  async stat(inputPath: string): Promise<FileStatResult> {
    const target = await this.lexicalPath(inputPath);
    await this.assertExistingParentInside(target);
    try {
      await this.assertExistingTargetInside(target);
      const metadata = await stat(target);
      const kind = classifyMode(metadata);
      return {
        path: target,
        exists: true,
        type: kind === "file" ? "file" : kind === "directory" ? "directory" : "other",
        size: metadata.size,
        modifiedAt: metadata.mtime.toISOString(),
      };
    } catch (error) {
      if (error instanceof GuestRpcError && error.code === "FILE_NOT_FOUND") {
        return { path: target, exists: false, type: "missing", size: 0 };
      }
      throw this.fileError(error, "FILE_STAT_FAILED", `Could not stat ${target}.`);
    }
  }

  /** Create a private directory for runtime state, still inside the sandbox. */
  async ensureDirectory(inputPath: string): Promise<string> {
    const target = this.lexicalPath(inputPath);
    await this.assertLexicallyInside(target);
    await this.assertExistingParentInside(target);
    await mkdir(target, { recursive: true });
    await this.assertExistingTargetInside(target);
    return target;
  }

  /** Allocate a safe path for a browser download without allowing filename traversal. */
  async downloadPath(inputFilename: string): Promise<string> {
    const safeName = basename(inputFilename).replace(/[\u0000\\/]/gu, "_").trim() || "download";
    return this.writablePath(join(this.rootPath, "Downloads", safeName));
  }

  async diagnostics(): Promise<{ root: string; workspace: string; writable: boolean }> {
    let writable = false;
    try {
      await this.ensureDirectory(".helm-guest-diagnostics");
      await access(this.rootPath, constants.W_OK);
      writable = true;
    } catch {
      writable = false;
    }

    return { root: this.rootPath, workspace: this.workspacePath, writable };
  }

  private lexicalPath(inputPath: string): string {
    if (typeof inputPath !== "string" || inputPath.length === 0) {
      throw new GuestRpcError("INVALID_PATH", "A non-empty path is required.", {
        httpStatus: 400,
      });
    }
    if (inputPath.includes("\u0000")) {
      throw new GuestRpcError("INVALID_PATH", "Paths cannot contain NUL characters.", {
        httpStatus: 400,
      });
    }

    const expanded = inputPath === "~"
      ? this.rootPath
      : inputPath.startsWith("~/")
        ? join(this.rootPath, inputPath.slice(2))
        : inputPath;
    return isAbsolute(expanded)
      ? resolve(expanded)
      : resolve(this.workspacePath, expanded);
  }

  private async existingPath(inputPath: string): Promise<string> {
    const target = this.lexicalPath(inputPath);
    await this.assertExistingTargetInside(target);
    return target;
  }

  private async writablePath(inputPath: string): Promise<string> {
    const target = this.lexicalPath(inputPath);
    await this.assertLexicallyInside(target);

    try {
      const metadata = await lstat(target);
      if (metadata.isSymbolicLink()) {
        throw new GuestRpcError(
          "SYMLINK_NOT_ALLOWED",
          "Writing through symbolic links is not allowed.",
        );
      }
      await this.assertExistingTargetInside(target);
    } catch (error) {
      if (!this.isMissing(error)) throw error;
    }

    await this.assertExistingParentInside(target);
    try {
      await mkdir(dirname(target), { recursive: true });
      await this.assertExistingTargetInside(dirname(target));
      return target;
    } catch (error) {
      throw this.fileError(error, "FILE_PARENT_CREATE_FAILED", `Could not prepare ${dirname(target)}.`);
    }
  }

  private async assertLexicallyInside(target: string): Promise<void> {
    if (!pathIsWithin(this.rootPath, target)) {
      throw new GuestRpcError(
        "FILE_OUTSIDE_SANDBOX",
        `The path must remain inside ${this.rootPath}.`,
        { httpStatus: 403 },
      );
    }
  }

  /**
   * Validate the nearest existing parent before creating or probing a path.
   * This closes the symlink-parent escape case where the final path itself
   * does not exist yet and therefore cannot be checked with realpath().
   */
  private async assertExistingParentInside(target: string): Promise<void> {
    await this.assertLexicallyInside(target);
    if (target === this.rootPath) {
      await this.getRootRealPath();
      return;
    }
    const root = await this.getRootRealPath();
    let candidate = dirname(target);

    while (true) {
      if (!pathIsWithin(this.rootPath, candidate)) {
        throw new GuestRpcError(
          "FILE_OUTSIDE_SANDBOX",
          `The path must remain inside ${this.rootPath}.`,
          { httpStatus: 403 },
        );
      }

      try {
        const resolvedCandidate = await realpath(candidate);
        if (!pathIsWithin(root, resolvedCandidate)) {
          throw new GuestRpcError(
            "FILE_OUTSIDE_SANDBOX",
            "The path resolves outside the guest sandbox.",
            { httpStatus: 403 },
          );
        }
        return;
      } catch (error) {
        if (!this.isMissing(error)) {
          if (error instanceof GuestRpcError) throw error;
          throw this.fileError(error, "FILE_REALPATH_FAILED", `Could not resolve ${candidate}.`);
        }
        const parent = dirname(candidate);
        if (parent === candidate) {
          throw new GuestRpcError(
            "SANDBOX_UNAVAILABLE",
            `Could not find an existing parent for ${target}.`,
          );
        }
        candidate = parent;
      }
    }
  }

  private async assertExistingTargetInside(target: string): Promise<void> {
    await this.assertLexicallyInside(target);
    const root = await this.getRootRealPath();

    let resolvedTarget: string;
    try {
      resolvedTarget = await realpath(target);
    } catch (error) {
      if (this.isMissing(error)) {
        throw new GuestRpcError("FILE_NOT_FOUND", `The path does not exist: ${target}.`);
      }
      throw this.fileError(error, "FILE_REALPATH_FAILED", `Could not resolve ${target}.`);
    }

    if (!pathIsWithin(root, resolvedTarget)) {
      throw new GuestRpcError(
        "FILE_OUTSIDE_SANDBOX",
        "The path resolves outside the guest sandbox.",
        { httpStatus: 403 },
      );
    }
  }

  private async getRootRealPath(): Promise<string> {
    if (this.rootRealPath !== undefined) return this.rootRealPath;
    try {
      await mkdir(this.rootPath, { recursive: true });
      this.rootRealPath = await realpath(this.rootPath);
      return this.rootRealPath;
    } catch (error) {
      throw this.fileError(error, "SANDBOX_UNAVAILABLE", `Could not access ${this.rootPath}.`);
    }
  }

  private isMissing(error: unknown): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    );
  }

  private fileError(error: unknown, fallbackCode: string, fallbackMessage: string): GuestRpcError {
    if (error instanceof GuestRpcError) return error;
    if (this.isMissing(error)) return new GuestRpcError("FILE_NOT_FOUND", fallbackMessage);

    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
    if (code === "EACCES" || code === "EPERM") {
      return new GuestRpcError("FILE_ACCESS_DENIED", fallbackMessage);
    }
    return new GuestRpcError(fallbackCode, fallbackMessage);
  }
}
