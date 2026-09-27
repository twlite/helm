import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  GUEST_PROTOCOL_VERSION,
  guestBuildManifestSchema,
  guestProtocolContractJson,
  type GuestBuildManifest,
} from '@helm/shared';

export const GUEST_BUILD_MANIFEST_FILENAME = 'helm-guest.manifest.json';
export const GUEST_RUNTIME_BUNDLE_FILENAME = 'helm-guest.js';

const BUILD_CONFIGURATION = [
  'bun', 'build', 'guest/helm-guest/src/index.ts', '--target=bun', '--bundle',
  '--external=playwright',
];

export class GuestBuildIdentityError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'GuestBuildIdentityError';
  }
}

export interface GuestBuildInputs {
  buildId: string;
  protocolContractSha256: string;
  bunVersion: string;
}

export interface VerifiedGuestBuild {
  manifest: GuestBuildManifest;
  bundlePath: string;
  actualBundleSha256: string;
  sourceVerified: boolean;
}

export function sha256Hex(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && path.endsWith('.ts')) files.push(path);
  }
  return files;
}

function guestBuildInputPaths(repositoryRoot: string): string[] {
  const sourcePaths = [
    ...sourceFiles(join(repositoryRoot, 'guest/helm-guest/src')),
    ...sourceFiles(join(repositoryRoot, 'packages/shared/src')),
  ];
  const fixedPaths = [
    'package.json',
    'bun.lock',
    'guest/helm-guest/package.json',
    'guest/helm-guest/tsconfig.json',
    'apps/server/src/vm/guest-build-identity.ts',
    'scripts/guest-build.ts',
  ].map(path => join(repositoryRoot, path));
  return [...new Set([...sourcePaths, ...fixedPaths])].sort((left, right) => left.localeCompare(right));
}

export function computeGuestBuildInputs(
  repositoryRoot: string,
  bunVersion = process.versions.bun ?? 'unknown',
): GuestBuildInputs {
  const records = guestBuildInputPaths(repositoryRoot).map(path => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(path);
    } catch (error) {
      throw new GuestBuildIdentityError(
        'GUEST_BUILD_INPUT_MISSING',
        `Guest build input is missing: ${relative(repositoryRoot, path)}`,
        { path: relative(repositoryRoot, path), cause: error instanceof Error ? error.message : String(error) },
      );
    }
    return {
      path: relative(repositoryRoot, path).split('\\').join('/'),
      sha256: sha256Hex(bytes),
    };
  });
  const protocolContractSha256 = sha256Hex(guestProtocolContractJson());
  const buildId = sha256Hex(JSON.stringify({
    identityVersion: 1,
    bunVersion,
    platform: process.platform,
    arch: process.arch,
    configuration: BUILD_CONFIGURATION,
    protocolContractSha256,
    inputs: records,
  }));
  return { buildId, protocolContractSha256, bunVersion };
}

export function readVerifiedGuestBuild(
  runtimeDir: string,
  repositoryRoot = resolveRepositoryRoot(),
): VerifiedGuestBuild {
  const guestDirectory = join(runtimeDir, 'guest');
  const bundlePath = join(guestDirectory, GUEST_RUNTIME_BUNDLE_FILENAME);
  const manifestPath = join(guestDirectory, GUEST_BUILD_MANIFEST_FILENAME);

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (error) {
    throw new GuestBuildIdentityError(
      'GUEST_BUILD_MANIFEST_MISSING',
      `The guest build manifest is unavailable at ${manifestPath}. Run bun run guest:build.`,
      { manifestPath, cause: error instanceof Error ? error.message : String(error) },
    );
  }

  const parsedManifest = guestBuildManifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) {
    throw new GuestBuildIdentityError(
      'GUEST_BUILD_MANIFEST_INVALID',
      `The guest build manifest is invalid at ${manifestPath}. Rebuild the guest runtime.`,
      { manifestPath, issues: parsedManifest.error.issues },
    );
  }
  const manifest = parsedManifest.data;
  const guestSourcesExist = existsSync(join(repositoryRoot, 'guest/helm-guest/src'));
  const sharedSourcesExist = existsSync(join(repositoryRoot, 'packages/shared/src'));
  let sourceVerified = false;
  if (guestSourcesExist && sharedSourcesExist) {
    const currentInputs = computeGuestBuildInputs(repositoryRoot, manifest.bunVersion);
    if (currentInputs.buildId !== manifest.buildId) {
      throw new GuestBuildIdentityError(
        'GUEST_BUILD_SOURCE_MISMATCH',
        'The guest bundle manifest was built from a different source tree. Run bun run guest:build.',
        {
          expectedBuildId: currentInputs.buildId,
          manifestBuildId: manifest.buildId,
          repositoryRoot,
        },
      );
    }
    sourceVerified = true;
  } else if (guestSourcesExist !== sharedSourcesExist) {
    throw new GuestBuildIdentityError(
      'GUEST_BUILD_SOURCE_INCOMPLETE',
      'Only part of the guest build source tree is available; source identity cannot be checked reliably.',
      { repositoryRoot, guestSourcesExist, sharedSourcesExist },
    );
  }
  if (manifest.protocolVersion !== GUEST_PROTOCOL_VERSION) {
    throw new GuestBuildIdentityError(
      'GUEST_PROTOCOL_VERSION_MISMATCH',
      `Guest manifest protocol ${manifest.protocolVersion} does not match server protocol ${GUEST_PROTOCOL_VERSION}.`,
      { manifestProtocolVersion: manifest.protocolVersion, serverProtocolVersion: GUEST_PROTOCOL_VERSION },
    );
  }

  const serverContractSha256 = sha256Hex(guestProtocolContractJson());
  if (manifest.protocolContractSha256 !== serverContractSha256) {
    throw new GuestBuildIdentityError(
      'GUEST_PROTOCOL_CONTRACT_MISMATCH',
      'The guest manifest protocol/tool contract does not match the contract loaded by the server.',
      {
        manifestProtocolContractSha256: manifest.protocolContractSha256,
        serverProtocolContractSha256: serverContractSha256,
      },
    );
  }

  let bundle: Buffer;
  try {
    bundle = readFileSync(bundlePath);
  } catch (error) {
    throw new GuestBuildIdentityError(
      'GUEST_BUNDLE_MISSING',
      `The guest runtime bundle is unavailable at ${bundlePath}. Run bun run guest:build.`,
      { bundlePath, cause: error instanceof Error ? error.message : String(error) },
    );
  }
  const actualBundleSha256 = sha256Hex(bundle);
  if (actualBundleSha256 !== manifest.bundleSha256) {
    throw new GuestBuildIdentityError(
      'GUEST_BUNDLE_MANIFEST_MISMATCH',
      'The on-disk guest bundle does not match its build manifest. Rebuild the guest runtime.',
      {
        bundlePath,
        manifestPath,
        expectedBundleSha256: manifest.bundleSha256,
        actualBundleSha256,
      },
    );
  }
  if (bundle.byteLength !== manifest.bundleSizeBytes) {
    throw new GuestBuildIdentityError(
      'GUEST_BUNDLE_SIZE_MISMATCH',
      'The on-disk guest bundle size does not match its build manifest.',
      {
        bundlePath,
        expectedBytes: manifest.bundleSizeBytes,
        actualBytes: bundle.byteLength,
      },
    );
  }

  return { manifest, bundlePath, actualBundleSha256, sourceVerified };
}

export function isGuestIdentityFailure(error: unknown): error is GuestBuildIdentityError {
  return error instanceof GuestBuildIdentityError;
}

export function resolveRepositoryRoot(): string {
  return resolve(import.meta.dir, '../../../../');
}
