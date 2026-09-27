export const GUEST_PROTOCOL_VERSION = 2 as const;

export interface GuestBuildManifest {
  manifestVersion: 1;
  runtime: 'helm-guest';
  buildId: string;
  protocolVersion: number;
  protocolContractSha256: string;
  bundleSha256: string;
  bundleSizeBytes: number;
  bunVersion: string;
}

export interface GuestHandshakeResult {
  runtime: 'helm-guest';
  protocolVersion: number;
  buildId: string;
  protocolContractSha256: string;
  bundleSha256?: string;
  serverId: string;
  methods: string[];
  sandbox?: {
    root: string;
    workspace: string;
  };
}
