import { execFileSync } from "node:child_process";
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

export const DEFAULT_WARM_DAEMON_IDLE_TTL_MS = 30 * 60 * 1000;

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
  /** Last timestamp this daemon was verified healthy / reused (used for idle TTL reaping). */
  lastUsedAt?: string;
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
  const hash = createHash("sha256").update(daemonKey(kind, deviceId)).digest("hex").slice(0, 10);
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
  if (!pid || pid <= 0 || pid === process.pid) return;
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

function resolveIdleTtlMs(explicit?: number): number {
  if (explicit !== undefined) return explicit;
  const envRaw = process.env["SPANA_DAEMON_IDLE_TTL_MS"];
  if (envRaw !== undefined) {
    const parsed = Number(envRaw);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_WARM_DAEMON_IDLE_TTL_MS;
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

  // If this exact scope already had a previous live daemon PID, terminate & clean it up
  // before overwriting the scope record so we never orphan a running browser/daemon process.
  const prev = existing.daemons[key];
  if (prev) {
    if (prev.pid && prev.pid !== record.pid && isPidAlive(prev.pid)) {
      killPidTree(prev.pid);
    }
    if (prev.tunnelPid && prev.tunnelPid !== record.tunnelPid && isPidAlive(prev.tunnelPid)) {
      killPidTree(prev.tunnelPid);
    }
    if (prev.userDataDir && prev.userDataDir !== record.userDataDir) {
      try {
        rmSync(prev.userDataDir, { recursive: true, force: true });
      } catch {
        // ignore temp profile cleanup error
      }
    }
  }

  const stamped: WarmDaemonRecord = {
    ...record,
    lastUsedAt: record.lastUsedAt ?? record.startedAt ?? new Date().toISOString(),
  };

  if (isUsingDefaultStateFile(stateFile)) {
    atomicWriteJson(scopeRecordPath(record.kind, record.deviceId), stamped);
    return;
  }

  existing.daemons[key] = stamped;
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
 * Removes stale or idle-expired records automatically.
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
    /** Idle TTL in ms (default: 30 minutes or `SPANA_DAEMON_IDLE_TTL_MS`). Pass 0 to disable. */
    idleTtlMs?: number;
    /** Current wall-clock time in ms (for deterministic testing). */
    nowMs?: number;
  } = {},
): Promise<WarmDaemonRecord | null> {
  const stateFile = options.stateFile ?? defaultDaemonStatePath();
  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? 1500;
  const statusPath = options.statusPath ?? (kind === "chromium" ? "/json/version" : "/status");
  const idleTtlMs = resolveIdleTtlMs(options.idleTtlMs);
  const nowMs = options.nowMs ?? Date.now();

  const record = isUsingDefaultStateFile(stateFile)
    ? (readScopeRecord(kind, deviceId) ??
      loadDaemonRegistry(stateFile).daemons[daemonKey(kind, deviceId)])
    : loadDaemonRegistry(stateFile).daemons[daemonKey(kind, deviceId)];
  if (!record) return null;

  if (idleTtlMs > 0) {
    const lastTs = Date.parse(record.lastUsedAt ?? record.startedAt);
    if (Number.isFinite(lastTs) && nowMs - lastTs > idleTtlMs) {
      stopWarmDaemon(kind, deviceId, stateFile);
      return null;
    }
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchFn(`http://${record.host}:${record.port}${statusPath}`, {
        signal: controller.signal,
      });
      if (res.ok) {
        const touched: WarmDaemonRecord = {
          ...record,
          lastUsedAt: new Date(nowMs).toISOString(),
        };
        if (isUsingDefaultStateFile(stateFile)) {
          try {
            atomicWriteJson(scopeRecordPath(kind, deviceId), touched);
          } catch {
            // ignore touch errors
          }
        } else {
          try {
            const registry = loadDaemonRegistry(stateFile);
            registry.daemons[daemonKey(kind, deviceId)] = touched;
            saveDaemonRegistry(registry, stateFile);
          } catch {
            // ignore touch errors
          }
        }
        return touched;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    // unreachable — prune stale entry
  }

  stopWarmDaemon(kind, deviceId, stateFile);
  return null;
}

/**
 * Stop any warm daemons whose `lastUsedAt` (or `startedAt`) exceeds `idleTtlMs`.
 */
export function reapIdleWarmDaemons(
  options: { stateFile?: string; idleTtlMs?: number; nowMs?: number } = {},
): number {
  const stateFile = options.stateFile ?? defaultDaemonStatePath();
  const idleTtlMs = resolveIdleTtlMs(options.idleTtlMs);
  if (idleTtlMs <= 0) return 0;
  const nowMs = options.nowMs ?? Date.now();
  const records = listWarmDaemons(stateFile);
  let reaped = 0;
  for (const record of records) {
    const lastTs = Date.parse(record.lastUsedAt ?? record.startedAt);
    if (Number.isFinite(lastTs) && nowMs - lastTs > idleTtlMs) {
      if (stopWarmDaemon(record.kind, record.deviceId, stateFile)) {
        reaped++;
      }
    }
  }
  return reaped;
}

const SPANA_BROWSER_PROFILE_MARKERS = [
  "spana-cdp-profile-",
  "spana-pw-profile-",
  "spana-browser-profile-",
];

/**
 * Sweep orphaned Chromium processes launched by Spana (identified by Spana's unique
 * temporary `--user-data-dir=.../spana-*-profile-*` argument) whose PIDs are no longer
 * tracked in the daemon registry, and remove their temporary profile directories.
 */
export function sweepOrphanedSpanaBrowsers(options: { excludePids?: Set<number> } = {}): number {
  if (process.platform === "win32") return 0;
  let psOut = "";
  try {
    psOut = execFileSync("ps", ["-ax", "-o", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return 0;
  }

  const exclude = options.excludePids ?? new Set<number>();
  let killed = 0;
  const profileDirsToClean = new Set<string>();

  for (const rawLine of psOut.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^(\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    const pid = Number.parseInt(match[1]!, 10);
    const cmd = match[2] ?? "";
    if (!Number.isFinite(pid) || pid <= 0 || pid === process.pid || exclude.has(pid)) continue;
    if (!SPANA_BROWSER_PROFILE_MARKERS.some((marker) => cmd.includes(marker))) continue;

    // Extract --user-data-dir=<path> for cleanup
    const dirMatch = /--user-data-dir=([^\s]+)/.exec(cmd);
    if (dirMatch?.[1] && SPANA_BROWSER_PROFILE_MARKERS.some((m) => dirMatch[1]!.includes(m))) {
      profileDirsToClean.add(dirMatch[1]!);
    }

    killPidTree(pid);
    killed++;
  }

  for (const dir of profileDirsToClean) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore temp profile cleanup errors
    }
  }

  return killed;
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
  if (isUsingDefaultStateFile(stateFile)) {
    stopped += sweepOrphanedSpanaBrowsers();
  }
  return stopped;
}
