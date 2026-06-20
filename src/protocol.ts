export const OBSYNC_PLUGIN_VERSION = "1.6.20";
export const OBSYNC_PROTOCOL_VERSION = 1;
export const OBSYNC_MIN_SERVER_PROTOCOL_VERSION = 1;

export interface CompatibilityResponse {
  ok: true;
  service: "obsync-server";
  serverVersion: string;
  protocolVersion: number;
  minClientProtocolVersion: number;
  minClientVersion: string;
  latestClientVersion: string;
  compatible: boolean;
  upgradeRequired: boolean;
  capabilities: string[];
  message?: string;
}
