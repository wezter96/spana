import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type WarmDaemonKind = "wda" | "uiautomator2" | "iproxy" | "chromium";

export interface WarmDaemonRecord {
  kind: WarmDaemonKind;
  deviceId: string;
  host: string;
  port: number;
  pid?: number;
  tunnelPid?: number;
  xctestrunPath?: string;
  /** Optional temporary profile directory created for this daemon (cleaned up on stop). */
  userDataDir?: string;
  /** Optional reusable WDA/UiAutomator2 session ID persisted across runs */
  sessionId?: string;
  bundleId?: string;
  startedAt: string;
}

interface DaemonRegistryFile {
  version: 1;
  daemons: Record<string, WarmDaemonRecord>;
}

export function defaultDaemonStatePath(): string {
  return join(tmpdir(), "spana-warm-daemons.json");
}

/** Per-scope atomic state directory so concurrent OS processes never overwrite each other's daemon records. */
export function defaultDaemonStateDir(): string {
  return join(tmpdir(), "spana-daemons");
}

function daemonKey(kind: WarmDaemonKind, deviceId: string): string {
  return `${kind}:${deviceId}`;
}

function scopeRecordPath(kind: WarmDaemonKind, deviceId: string): string {
  const safe = `${kind}-${deviceId}`.replaceAll(/[^a-zA-Z0-9._-]/g, "_").slice(0, 64);
  const hash = createHash("sha1").update(daemonKey(kind, deviceId)).digest("hex").slice(0, 10);
  return join(defaultDaemonStateDir(), `${safe}-${hash}.json`);
}

function isUsingDefaultStateFile(stateFile?: string): boolean {
  return !stateFile || stateFile === defaultDaemonStatePath();
}

function atomicWriteJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmpPath, filePath);
}

function loadScopeRecords(): Record<string, WarmDaemonRecord> {
  const dir = defaultDaemonStateDir();
  const out: Record<string, WarmDaemonRecord> = {};
  if (!existsSync(dir)) return out;
  try {
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, file), "utf-8")) as WarmDaemonRecord;
        if (parsed && typeof parsed.kind === "string" && typeof parsed.deviceId === "string") {
          out[daemonKey(parsed.kind, parsed.deviceId)] = parsed;
        }
      } catch {
        // skip corrupted scope file
      }
    }
  } catch {
    // ignore unreadable dir
  }
  return out;
}

function readScopeRecord(kind: WarmDaemonKind, deviceId: string): WarmDaemonRecord | undefined {
  const filePath = scopeRecordPath(kind, deviceId);
  if (!existsSync(filePath)) return undefined;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as WarmDaemonRecord;
  } catch {
    return undefined;
  }
}

function deleteScopeRecord(kind: WarmDaemonKind, deviceId: string): void {
  const filePath = scopeRecordPath(kind, deviceId);
  try {
    if (existsSync(filePath)) unlinkSync(filePath);
  } catch {
    // already removed
  }
}

function killPidTree(pid: number | undefined): void {
  if (!pid || pid <= 0) return;
  const targets = process.platform !== "win32" ? [-pid, pid] : [pid];
  for (const target of targets) {
    try {
      process.kill(target, "SIGTERM");
    } catch {
      // process or group already exited
    }
  }
  // If the detached daemon ignores SIGTERM, escalate to SIGKILL immediately when still alive
  if (isPidAlive(pid)) {
    for (const target of targets) {
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // already exited
      }
    }
  }
}

export function loadDaemonRegistry(stateFile = defaultDaemonStatePath()): DaemonRegistryFile {
  const merged: Record<string, WarmDaemonRecord> = {};
  if (existsSync(stateFile)) {
    try {
      const raw = readFileSync(stateFile, "utf-8");
      const parsed = JSON.parse(raw) as DaemonRegistryFile;
      if (parsed && parsed.version === 1 && typeof parsed.daemons === "object") {
        Object.assign(merged, parsed.daemons);
      }
    } catch {
      // corrupted state file — reset cleanly
    }
  }
  if (isUsingDefaultStateFile(stateFile)) {
    Object.assign(merged, loadScopeRecords());
  }
  return { version: 1, daemons: merged };
}

export function saveDaemonRegistry(
  registry: DaemonRegistryFile,
  stateFile = defaultDaemonStatePath(),
): void {
  atomicWriteJson(stateFile, registry);
}

export function registerWarmDaemon(
  record: WarmDaemonRecord,
  stateFile = defaultDaemonStatePath(),
): void {
  const key = daemonKey(record.kind, record.deviceId);
  const existing = loadDaemonRegistry(stateFile);
  // Fail loudly if another live daemon with a DIFFERENT scope already owns this exact host:port
  for (const [otherKey, other] of Object.entries(existing.daemons)) {
    if (
      otherKey !== key &&
      other.host === record.host &&
      other.port === record.port &&
      isPidAlive(other.pid)
    ) {
      throw new Error(
        `Warm daemon port clash on ${record.host}:${record.port}: scope "${otherKey}" (pid ${other.pid}) already owns this port.`,
      );
    }
  }

  if (isUsingDefaultStateFile(stateFile)) {
    atomicWriteJson(scopeRecordPath(record.kind, record.deviceId), record);
    return;
  }

  existing.daemons[key] = record;
  saveDaemonRegistry(existing, stateFile);
}

/** Persist a warm WDA/UiAutomator2 session ID on an existing daemon record for cross-run reuse. */
export function updateWarmDaemonSession(
  kind: WarmDaemonKind,
  deviceId: string,
  sessionId: string,
  bundleId?: string,
  stateFile = defaultDaemonStatePath(),
): void {
  if (isUsingDefaultStateFile(stateFile)) {
    const scopeRec = readScopeRecord(kind, deviceId);
    if (scopeRec) {
      atomicWriteJson(scopeRecordPath(kind, deviceId), {
        ...scopeRec,
        sessionId,
        ...(bundleId ? { bundleId } : {}),
      });
      return;
    }
  }
  const registry = loadDaemonRegistry(stateFile);
  const key = daemonKey(kind, deviceId);
  const existing = registry.daemons[key];
  if (!existing) return;
  registry.daemons[key] = { ...existing, sessionId, ...(bundleId ? { bundleId } : {}) };
  saveDaemonRegistry(registry, stateFile);
}

export function unregisterWarmDaemon(
  kind: WarmDaemonKind,
  deviceId: string,
  stateFile = defaultDaemonStatePath(),
): void {
  if (isUsingDefaultStateFile(stateFile)) {
    deleteScopeRecord(kind, deviceId);
  }
  if (existsSync(stateFile)) {
    const raw = loadDaemonRegistry(stateFile);
    if (daemonKey(kind, deviceId) in raw.daemons) {
      delete raw.daemons[daemonKey(kind, deviceId)];
      saveDaemonRegistry(raw, stateFile);
    }
  }
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
 * Probe whether a recorded warm WDA / UiAutomator2 / Chromium daemon is still healthy.
 * Removes stale records automatically.
 */
export async function getHealthyWarmDaemon(
  kind: WarmDaemonKind,
  deviceId: string,
  options: {
    stateFile?: string;
    fetchFn?: typeof fetch;
    timeoutMs?: number;
    /** HTTP health endpoint path (default: "/status", use "/json/version" for chromium). */
    statusPath?: string;
  } = {},
): Promise<WarmDaemonRecord | null> {
  const stateFile = options.stateFile ?? defaultDaemonStatePath();
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const statusPath = options.statusPath ?? (kind === "chromium" ? "/json/version" : "/status");

  const record = isUsingDefaultStateFile(stateFile)
    ? (readScopeRecord(kind, deviceId) ??
      loadDaemonRegistry(stateFile).daemons[daemonKey(kind, deviceId)])
    : loadDaemonRegistry(stateFile).daemons[daemonKey(kind, deviceId)];
  if (!record) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`http://${record.host}:${record.port}${statusPath}`, {
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

  unregisterWarmDaemon(kind, deviceId, stateFile);
  return null;
}

/**
 * Stop the specific process PIDs (and process groups) started by Spana for this daemon record.
 */
export function stopWarmDaemon(
  kind: WarmDaemonKind,
  deviceId: string,
  stateFile = defaultDaemonStatePath(),
): boolean {
  const key = daemonKey(kind, deviceId);
  const record = isUsingDefaultStateFile(stateFile)
    ? (readScopeRecord(kind, deviceId) ?? loadDaemonRegistry(stateFile).daemons[key])
    : loadDaemonRegistry(stateFile).daemons[key];
  if (!record) return false;

  killPidTree(record.pid);
  killPidTree(record.tunnelPid);

  if (record.userDataDir) {
    try {
      rmSync(record.userDataDir, { recursive: true, force: true });
    } catch {
      // ignore temp profile cleanup error
    }
  }

  unregisterWarmDaemon(kind, deviceId, stateFile);
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
