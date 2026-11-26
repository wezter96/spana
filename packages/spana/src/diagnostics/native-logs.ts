import { execFile } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface NativeLogCaptureOptions {
  /** Maximum lines to return from Android logcat (default: 400). */
  maxLines?: number;
  /** Optional package name / process filter substring. */
  filter?: string;
  /** Command execution timeout in ms (default: 5_000). */
  timeoutMs?: number;
  /** Custom execFile runner (for deterministic unit tests). */
  execFileFn?: (
    cmd: string,
    args: string[],
    opts: { timeout: number; maxBuffer: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface IosCrashLogEntry {
  fileName: string;
  filePath: string;
  modifiedAt: string;
  preview: string;
}

function defaultExecFile(
  cmd: string,
  args: string[],
  opts: { timeout: number; maxBuffer: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Capture recent Android device/emulator logcat lines (`adb -s <id> logcat -d -t <N>`).
 * Returns `null` if `adb` is unavailable or fails cleanly without throwing.
 */
export async function captureAndroidLogcat(
  deviceId?: string,
  opts: NativeLogCaptureOptions = {},
): Promise<string | null> {
  const maxLines = Math.max(10, opts.maxLines ?? 400);
  const timeout = opts.timeoutMs ?? 5_000;
  const run = opts.execFileFn ?? defaultExecFile;
  const args = [
    ...(deviceId ? ["-s", deviceId] : []),
    "logcat",
    "-d",
    "-t",
    String(maxLines),
    "-v",
    "time",
  ];
  try {
    const { stdout } = await run("adb", args, {
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    const lines = stdout.split(/\r?\n/);
    const filtered = opts.filter
      ? lines.filter((line) => line.toLowerCase().includes(opts.filter!.toLowerCase()))
      : lines;
    const joined = filtered.join("\n").trim();
    return joined.length > 0 ? joined : null;
  } catch {
    return null;
  }
}

/**
 * Collect recent iOS Simulator crash logs from `~/Library/Logs/DiagnosticReports`
 * (filtered by optional bundle/app name and `sinceMs` timestamp).
 */
export function captureIosSimulatorCrashLogs(opts?: {
  bundleOrAppName?: string;
  sinceMs?: number;
  maxFiles?: number;
  reportsDir?: string;
}): IosCrashLogEntry[] {
  const dir = opts?.reportsDir ?? join(homedir(), "Library", "Logs", "DiagnosticReports");
  if (!existsSync(dir)) return [];

  const maxFiles = Math.max(1, opts?.maxFiles ?? 5);
  const sinceMs = opts?.sinceMs ?? Date.now() - 10 * 60 * 1000;
  const needle = opts?.bundleOrAppName?.toLowerCase();

  try {
    const candidates = readdirSync(dir)
      .filter((name) => name.endsWith(".ips") || name.endsWith(".crash"))
      .filter((name) => (!needle ? true : name.toLowerCase().includes(needle)))
      .map((name) => {
        const filePath = join(dir, name);
        const st = statSync(filePath);
        return { name, filePath, mtimeMs: st.mtimeMs };
      })
      .filter((item) => item.mtimeMs >= sinceMs)
      .toSorted((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, maxFiles);

    return candidates.map((item) => {
      let preview = "";
      try {
        preview = readFileSync(item.filePath, "utf8").slice(0, 4_000);
      } catch {
        preview = "(unreadable)";
      }
      return {
        fileName: item.name,
        filePath: item.filePath,
        modifiedAt: new Date(item.mtimeMs).toISOString(),
        preview,
      };
    });
  } catch {
    return [];
  }
}
