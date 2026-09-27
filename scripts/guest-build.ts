import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GUEST_PROTOCOL_VERSION } from '../packages/shared/src/guest-identity';
import {
  computeGuestBuildInputs,
  GUEST_BUILD_MANIFEST_FILENAME,
  sha256Hex,
} from '../apps/server/src/vm/guest-build-identity';
import { guestProtocolContractJson } from '../packages/shared/src/schemas';
import { loadConfig } from '../apps/server/src/config';

const repositoryRoot = resolve(import.meta.dir, '..');
const sourceDirectory = join(repositoryRoot, 'runtime', 'guest');
const bundlePath = join(sourceDirectory, 'helm-guest.js');
const temporaryBundlePath = join(sourceDirectory, `.helm-guest-${process.pid}.tmp.js`);
const temporaryManifestPath = join(sourceDirectory, `.helm-guest-${process.pid}.manifest.tmp`);
const config = loadConfig();
const destinationDirectory = join(config.runtimeDir, 'guest');
const destinationIsSource = resolve(destinationDirectory) === resolve(sourceDirectory);
const destinationBundlePath = join(destinationDirectory, 'helm-guest.js');
const destinationManifestPath = join(destinationDirectory, GUEST_BUILD_MANIFEST_FILENAME);
const temporaryDestinationBundlePath = join(destinationDirectory, `.helm-guest-${process.pid}.tmp.js`);
const temporaryDestinationManifestPath = join(destinationDirectory, `.helm-guest-${process.pid}.manifest.tmp`);

mkdirSync(sourceDirectory, { recursive: true });
mkdirSync(destinationDirectory, { recursive: true });

const buildInputs = computeGuestBuildInputs(repositoryRoot);
const protocolContractSha256 = sha256Hex(guestProtocolContractJson());
if (protocolContractSha256 !== buildInputs.protocolContractSha256) {
  throw new Error('Protocol contract changed while preparing the guest build. Retry the build.');
}

const child = Bun.spawn([
  'bun',
  'build',
  'guest/helm-guest/src/index.ts',
  '--target=bun',
  '--bundle',
  '--external=playwright',
  '--define',
  `__HELM_GUEST_BUILD_ID__=${JSON.stringify(buildInputs.buildId)}`,
  '--define',
  `__HELM_GUEST_PROTOCOL_CONTRACT_SHA256__=${JSON.stringify(protocolContractSha256)}`,
  `--outfile=${temporaryBundlePath}`,
], {
  cwd: repositoryRoot,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
});

const exitCode = await child.exited;
if (exitCode !== 0) {
  rmSync(temporaryBundlePath, { force: true });
  process.exitCode = exitCode;
} else {
  if (!existsSync(temporaryBundlePath)) {
    throw new Error(`Guest build completed without producing ${temporaryBundlePath}`);
  }

  const bundleBytes = readFileSync(temporaryBundlePath);
  const manifest = {
    manifestVersion: 1 as const,
    runtime: 'helm-guest' as const,
    buildId: buildInputs.buildId,
    protocolVersion: GUEST_PROTOCOL_VERSION,
    protocolContractSha256,
    bundleSha256: createHash('sha256').update(bundleBytes).digest('hex'),
    bundleSizeBytes: bundleBytes.byteLength,
    bunVersion: buildInputs.bunVersion,
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;

  writeFileSync(temporaryManifestPath, manifestJson);
  if (!destinationIsSource) {
    copyFileSync(temporaryBundlePath, temporaryDestinationBundlePath);
    writeFileSync(temporaryDestinationManifestPath, manifestJson);
  }

  renameSync(temporaryBundlePath, bundlePath);
  renameSync(temporaryManifestPath, join(sourceDirectory, GUEST_BUILD_MANIFEST_FILENAME));
  if (!destinationIsSource) {
    renameSync(temporaryDestinationBundlePath, destinationBundlePath);
    renameSync(temporaryDestinationManifestPath, destinationManifestPath);
  }

  console.log(`Built guest ${buildInputs.buildId}`);
  console.log(`Bundle SHA-256 ${manifest.bundleSha256}`);
  console.log(destinationIsSource
    ? `Built guest runtime and manifest at ${sourceDirectory}`
    : `Copied guest runtime and manifest to ${destinationDirectory}`);
}

for (const path of [
  temporaryBundlePath,
  temporaryManifestPath,
  temporaryDestinationBundlePath,
  temporaryDestinationManifestPath,
]) {
  rmSync(path, { force: true });
}
