import type { NetworkConditions, NetworkProfile } from "./raw-driver.js";

export interface ResolvedNetworkConditions {
  offline: boolean;
  latencyMs: number;
  downloadThroughputKbps: number;
  uploadThroughputKbps: number;
}

const PROFILES: Record<NetworkProfile, ResolvedNetworkConditions> = {
  wifi: { offline: false, latencyMs: 2, downloadThroughputKbps: 30000, uploadThroughputKbps: 15000 },
  "4g": { offline: false, latencyMs: 20, downloadThroughputKbps: 20000, uploadThroughputKbps: 10000 },
  "3g": { offline: false, latencyMs: 100, downloadThroughputKbps: 1500, uploadThroughputKbps: 750 },
  "2g": { offline: false, latencyMs: 300, downloadThroughputKbps: 280, uploadThroughputKbps: 256 },
  edge: { offline: false, latencyMs: 400, downloadThroughputKbps: 240, uploadThroughputKbps: 200 },
  offline: { offline: true, latencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
};

export function resolveNetworkConditions(conditions: NetworkConditions): ResolvedNetworkConditions {
  if (conditions.profile) {
    return { ...PROFILES[conditions.profile] };
  }

  return {
    offline: conditions.offline ?? false,
    latencyMs: conditions.latencyMs ?? 0,
    downloadThroughputKbps: conditions.downloadThroughputKbps ?? -1,
    uploadThroughputKbps: conditions.uploadThroughputKbps ?? -1,
  };
}
