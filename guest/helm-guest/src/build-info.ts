import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { GUEST_PROTOCOL_VERSION } from '../../../packages/shared/src/guest-identity';

declare const __HELM_GUEST_BUILD_ID__: string | undefined;
declare const __HELM_GUEST_PROTOCOL_CONTRACT_SHA256__: string | undefined;

function loadedBundleSha256(): string | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint || basename(entrypoint) !== 'helm-guest.js') return undefined;
  try {
    return createHash('sha256').update(readFileSync(entrypoint)).digest('hex');
  } catch {
    return undefined;
  }
}

export const GUEST_BUILD_IDENTITY = Object.freeze({
  buildId: typeof __HELM_GUEST_BUILD_ID__ === 'string'
    ? __HELM_GUEST_BUILD_ID__
    : 'development-unbuilt',
  protocolVersion: GUEST_PROTOCOL_VERSION,
  protocolContractSha256: typeof __HELM_GUEST_PROTOCOL_CONTRACT_SHA256__ === 'string'
    ? __HELM_GUEST_PROTOCOL_CONTRACT_SHA256__
    : 'development-unbuilt',
  bundleSha256: loadedBundleSha256(),
});

export type GuestBuildIdentity = typeof GUEST_BUILD_IDENTITY;
