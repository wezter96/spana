import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type WarmDaemonKind = "wda" | "uiautomator2" | "iproxy";

export interface WarmDaemonRecord {
  kind: WarmDaemonKind;
  deviceId: string;
  host: string;
  port: number;
  pid?: number;
  tunnelPid?: number;
  xctestrunPath?: string;
  startedAt: string;
}

interface DaemonRegistryFile {
  version: 1;
  daemons: Record<string, WarmDaemonRecord>;
}

export function defaultDaemonStatePath(): string {
  return join(tmpdir(), "spana-warm-daemons.json");
}

function daemonKey(kind: WarmDaemonKind, deviceId: string): string {
  return `${kind}:${deviceId}`;
}

export function loadDaemonRegistry(stateFile = defaultDaemonStatePath()): DaemonRegistryFile {
  if (!existsSync(stateFile)) {
    return { version: 1, daemons: {} };
  }
  try {
    const raw = readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as DaemonRegistryFile;
    if (parsed && parsed.version === 1 && typeof parsed.daemons === "object") {
      return parsed;
    }
  } catch {
    // corrupted state file — reset cleanly
  }
  return { version: 1, daemons: {} };
}

export function saveDaemonRegistry(
  registry: DaemonRegistryFile,
  stateFile = defaultDaemonStatePath(),
): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(stateFile, JSON.stringify(registry, null, 2), "utf-8");
}

export function registerWarmDaemon(
  record: WarmDaemonRecord,
  stateFile = defaultDaemonStatePath(),
): void {
  const registry = loadDaemonRegistry(stateFile);
  registry.daemons[daemonKey(record.kind, record.deviceId)] = record;
  saveDaemonRegistry(registry, stateFile);
}

export function unregisterWarmDaemon(
  kind: WarmDaemonKind,
  deviceId: string,
  stateFile = defaultDaemonStatePath(),
): void {
  const registry = loadDaemonRegistry(stateFile);
  delete registry.daemons[daemonKey(kind, deviceId)];
  saveDaemonRegistry(registry, stateFile);
}

export function listWarmDaemons(stateFile = defaultDaemonStatePath()): WarmDaemonRecord[] {
  return Object.values(loadDaemonRegistry(stateFile).daemons);
}

export function isPidAlive(pid: number | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe whether a recorded warm WDA / UiAutomator2 daemon is still healthy on
 * `GET http://<host>:<port>/status`. Removes stale records automatically.
 */
export async function getHealthyWarmDaemon(
  kind: WarmDaemonKind,
  deviceId: string,
  options: {
    stateFile?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
  } = {},
): Promise<WarmDaemonRecord | null> {
  const stateFile = options.stateFile ?? defaultDaemonStatePath();
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;

  const registry = loadDaemonRegistry(stateFile);
  const record = registry.daemons[daemonKey(kind, deviceId)];
  if (!record) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`http://${record.host}:${record.port}/status`, {
        signal: controller.signal,
      });
      if (res.ok) {
        return record;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // unreachable — prune stale entry
  }

  delete registry.daemons[daemonKey(kind, deviceId)];
  saveDaemonRegistry(registry, stateFile);
  return null;
}

/**
 * Stop only the specific process PIDs started by Spana for this daemon record.
 */
export function stopWarmDaemon(
  kind: WarmDaemonKind,
  deviceId: string,
  stateFile = defaultDaemonStatePath(),
): boolean {
  const registry = loadDaemonRegistry(stateFile);
  const key = daemonKey(kind, deviceId);
  const record = registry.daemons[key];
  if (!record) return false;

  for (const pid of [record.pid, record.tunnelPid]) {
    if (pid && pid > 0) {
      try {
        process.kill(pid);
      } catch {
        // already exited
      }
    }
  }

  delete registry.daemons[key];
  saveDaemonRegistry(registry, stateFile);
  return true;
}

export function stopAllWarmDaemons(stateFile = defaultDaemonStatePath()): number {
  const records = listWarmDaemons(stateFile);
  let stopped = 0;
  for (const record of records) {
    if (stopWarmDaemon(record.kind, record.deviceId, stateFile)) {
      stopped++;
    }
  }
  return stopped;
}
