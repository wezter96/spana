import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StepResult } from "../report/types.js";

export type VideoRecordingMode = "off" | "on" | "retain-on-failure";

export interface PlaybackFrame {
  /** Milliseconds elapsed since flow start. */
  timestampMs: number;
  /** Base64-encoded image bytes (no `data:` prefix). */
  dataBase64: string;
  mimeType: "image/jpeg" | "image/png";
}

export interface PlaybackStepMarker {
  index: number;
  command: string;
  selector?: unknown;
  /** Relative ms since flow start when this step started. */
  startedAtMs: number;
  durationMs: number;
  status: "passed" | "failed";
  error?: string;
  /** Optional viewport pixel coordinate tapped during this step (for click-ripple overlay). */
  tapPoint?: { x: number; y: number };
}

export interface FlowPlaybackTrace {
  version: 1;
  flowName: string;
  platform: string;
  startedAtIso: string;
  durationMs: number;
  viewport?: { width: number; height: number };
  frames: PlaybackFrame[];
  steps: PlaybackStepMarker[];
  videoPath?: string;
}

export interface StopRecordingOptions {
  keep: boolean;
  outputDir: string;
  fileStem: string;
  steps?: PlaybackStepMarker[];
  viewport?: { width: number; height: number };
}

export interface StopRecordingResult {
  playbackJsonPath?: string;
  videoPath?: string;
  frameCount: number;
}

export interface VideoRecorderHandle {
  stop(opts: StopRecordingOptions): Promise<StopRecordingResult>;
}

export interface CdpScreencastLike {
  sendCommand<T = any>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<T>;
  onEvent(method: string, listener: (params: any, sessionId?: string) => void): () => void;
}

export interface CdpScreencastRecorderOptions {
  flowName: string;
  platform: string;
  /** Max captured JPEG frames per flow (ring-bounded). Default: 180. */
  maxFrames?: number;
  /** JPEG quality 1–100. Default: 65 (fast & compact). */
  quality?: number;
  maxWidth?: number;
  maxHeight?: number;
  everyNthFrame?: number;
  /** Attempt to mux captured JPEG frames into an `.mp4` via `ffmpeg` if available on PATH. Default: true. */
  exportMp4?: boolean;
  spawnFn?: typeof spawn;
}

function hasFfmpegOnPath(): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["ffmpeg"], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort mux of captured JPEG frames into an H.264 `.mp4` via `ffmpeg`.
 * Returns the written `outputPath` on success, or `undefined` if `ffmpeg` isn't available.
 */
export async function exportFramesToMp4(
  frames: PlaybackFrame[],
  outputPath: string,
  spawnFn: typeof spawn = spawn,
): Promise<string | undefined> {
  if (frames.length === 0 || !hasFfmpegOnPath()) return undefined;

  const tempDir = mkdtempSync(join(tmpdir(), "spana-vid-"));
  try {
    const ext = frames[0]!.mimeType === "image/png" ? "png" : "jpg";
    const listLines: string[] = [];
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i]!;
      const framePath = join(tempDir, `frame-${String(i).padStart(5, "0")}.${ext}`);
      writeFileSync(framePath, Buffer.from(f.dataBase64, "base64"));
      const nextTs = frames[i + 1]?.timestampMs ?? f.timestampMs + 250;
      const durSec = Math.max(0.05, Math.min(2, (nextTs - f.timestampMs) / 1000));
      listLines.push(`file '${framePath.replaceAll("'", "'\\''")}'`);
      listLines.push(`duration ${durSec.toFixed(3)}`);
    }
    // ffmpeg concat demuxer requires repeating the final file entry
    const lastPath = join(tempDir, `frame-${String(frames.length - 1).padStart(5, "0")}.${ext}`);
    listLines.push(`file '${lastPath.replaceAll("'", "'\\''")}'`);

    const listFile = join(tempDir, "frames.txt");
    writeFileSync(listFile, listLines.join("\n"), "utf8");

    const ok = await new Promise<boolean>((resolve) => {
      const child = spawnFn(
        "ffmpeg",
        [
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          listFile,
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          outputPath,
        ],
        { stdio: "ignore" },
      );
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });

    return ok && existsSync(outputPath) ? outputPath : undefined;
  } catch {
    return undefined;
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors
    }
  }
}

/**
 * Start asynchronous Chromium CDP screencast recording (`Page.startScreencast`).
 * Captures lightweight JPEG frames directly from Chromium's compositor with minimal
 * test overhead, writes a self-contained `*-playback.json` trace for `report.html`,
 * and optionally exports an `.mp4` video if `ffmpeg` is available.
 */
export async function startCdpScreencastRecorder(
  cdp: CdpScreencastLike,
  options: CdpScreencastRecorderOptions,
): Promise<VideoRecorderHandle> {
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  const maxFrames = options.maxFrames ?? 180;
  const frames: PlaybackFrame[] = [];
  let stopped = false;

  const unsubscribe = cdp.onEvent("Page.screencastFrame", (params) => {
    if (stopped) return;
    const sessionId = params?.sessionId;
    if (sessionId !== undefined) {
      void cdp.sendCommand("Page.screencastFrameAck", { sessionId }).catch(() => {});
    }
    if (typeof params?.data === "string" && params.data.length > 0) {
      if (frames.length >= maxFrames) {
        // Keep evenly spaced timeline by dropping oldest non-initial frame
        frames.splice(1, 1);
      }
      frames.push({
        timestampMs: Math.max(0, Date.now() - startedAt),
        dataBase64: params.data,
        mimeType: "image/jpeg",
      });
    }
  });

  await cdp
    .sendCommand("Page.startScreencast", {
      format: "jpeg",
      quality: options.quality ?? 65,
      maxWidth: options.maxWidth ?? 1280,
      maxHeight: options.maxHeight ?? 720,
      everyNthFrame: options.everyNthFrame ?? 2,
    })
    .catch(() => {});

  return {
    stop: async (stopOpts: StopRecordingOptions): Promise<StopRecordingResult> => {
      if (stopped) return { frameCount: frames.length };
      stopped = true;
      unsubscribe();
      await cdp.sendCommand("Page.stopScreencast").catch(() => {});

      if (!stopOpts.keep) {
        return { frameCount: 0 };
      }

      // Ultra-fast flows can finish before Chromium's compositor flushes the first screencast frame.
      // Capture a single final JPEG frame so playback traces are never dropped on fast runs.
      if (frames.length === 0) {
        try {
          const snap = (await cdp.sendCommand("Page.captureScreenshot", {
            format: "jpeg",
            quality: options.quality ?? 65,
          })) as { data?: string } | undefined;
          if (typeof snap?.data === "string" && snap.data.length > 0) {
            frames.push({
              timestampMs: Math.max(0, Date.now() - startedAt),
              dataBase64: snap.data,
              mimeType: "image/jpeg",
            });
          }
        } catch {
          // best-effort fallback
        }
      }

      if (frames.length === 0) {
        return { frameCount: 0 };
      }

      mkdirSync(stopOpts.outputDir, { recursive: true });
      let videoPath: string | undefined;
      if (options.exportMp4 !== false) {
        const mp4Target = join(stopOpts.outputDir, `${stopOpts.fileStem}.mp4`);
        videoPath = await exportFramesToMp4(frames, mp4Target, options.spawnFn);
      }

      const trace: FlowPlaybackTrace = {
        version: 1,
        flowName: options.flowName,
        platform: options.platform,
        startedAtIso,
        durationMs: Math.max(1, Date.now() - startedAt),
        viewport: stopOpts.viewport,
        frames,
        steps: stopOpts.steps ?? [],
        ...(videoPath ? { videoPath } : {}),
      };

      const playbackJsonPath = join(stopOpts.outputDir, `${stopOpts.fileStem}-playback.json`);
      writeFileSync(playbackJsonPath, JSON.stringify(trace), "utf8");
      return { playbackJsonPath, videoPath, frameCount: frames.length };
    },
  };
}

/**
 * Start native Android screen recording via `adb shell screenrecord`.
 * Automatically pulls the `.mp4` on stop when `keep: true` and cleans up the device file.
 */
export function startAndroidVideoRecorder(
  serial: string,
  options: {
    outputPath: string;
    spawnFn?: typeof spawn;
    execFileSyncFn?: typeof execFileSync;
  },
): VideoRecorderHandle {
  const spawnFn = options.spawnFn ?? spawn;
  const execSyncFn = options.execFileSyncFn ?? execFileSync;
  const remotePath = `/sdcard/spana-rec-${Date.now()}-${Math.floor(Math.random() * 10000)}.mp4`;

  const child: ChildProcess = spawnFn(
    "adb",
    ["-s", serial, "shell", "screenrecord", "--time-limit", "180", remotePath],
    { stdio: "ignore" },
  );

  let stopped = false;
  return {
    stop: async ({ keep }: StopRecordingOptions): Promise<StopRecordingResult> => {
      if (stopped) return { frameCount: 0 };
      stopped = true;

      try {
        child.kill("SIGINT");
      } catch {
        // already exited
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1200);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      let savedPath: string | undefined;
      if (keep) {
        try {
          execSyncFn("adb", ["-s", serial, "pull", remotePath, options.outputPath], {
            stdio: "ignore",
          });
          if (existsSync(options.outputPath)) savedPath = options.outputPath;
        } catch {
          // pull failed — non-fatal
        }
      }

      try {
        execSyncFn("adb", ["-s", serial, "shell", "rm", "-f", remotePath], { stdio: "ignore" });
      } catch {
        // cleanup best-effort
      }

      return { videoPath: savedPath, frameCount: savedPath ? 1 : 0 };
    },
  };
}

/**
 * Start native iOS Simulator H.264 video recording via `xcrun simctl io <udid> recordVideo`.
 */
export function startIosSimulatorVideoRecorder(
  udid: string,
  options: {
    outputPath: string;
    spawnFn?: typeof spawn;
  },
): VideoRecorderHandle {
  const spawnFn = options.spawnFn ?? spawn;
  const child: ChildProcess = spawnFn(
    "xcrun",
    ["simctl", "io", udid, "recordVideo", "--codec=h264", "--force", options.outputPath],
    { stdio: "ignore" },
  );

  let stopped = false;
  return {
    stop: async ({ keep }: StopRecordingOptions): Promise<StopRecordingResult> => {
      if (stopped) return { frameCount: 0 };
      stopped = true;

      try {
        child.kill("SIGINT");
      } catch {
        // already exited
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1500);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });

      if (!keep) {
        try {
          if (existsSync(options.outputPath)) unlinkSync(options.outputPath);
        } catch {
          // ignore
        }
        return { frameCount: 0 };
      }

      return {
        videoPath: existsSync(options.outputPath) ? options.outputPath : undefined,
        frameCount: existsSync(options.outputPath) ? 1 : 0,
      };
    },
  };
}

/**
 * Fallback playback trace builder from step screenshots (`artifacts.captureSteps: true`).
 * Guarantees interactive step-by-step playback works on EVERY target (Web, Playwright,
 * Android, iOS, Electron, Electrobun) even without CDP screencast or ffmpeg.
 */
export function buildPlaybackTraceFromSteps(input: {
  flowName: string;
  platform: string;
  durationMs: number;
  steps: StepResult[];
  viewport?: { width: number; height: number };
  videoPath?: string;
}): FlowPlaybackTrace | null {
  const frames: PlaybackFrame[] = [];
  const markers: PlaybackStepMarker[] = [];
  let cursorMs = 0;

  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i]!;
    const tapPoint = extractTapPointFromStep(step);
    markers.push({
      index: i,
      command: step.command,
      selector: step.selector,
      startedAtMs: cursorMs,
      durationMs: step.durationMs,
      status: step.status,
      error: step.error,
      ...(tapPoint ? { tapPoint } : {}),
    });

    const img = step.attachments?.find(
      (a) => a.contentType === "image/png" || a.contentType === "image/jpeg",
    );
    if (img && existsSync(img.path)) {
      try {
        const dataBase64 = readFileSync(img.path).toString("base64");
        frames.push({
          timestampMs: cursorMs + step.durationMs,
          dataBase64,
          mimeType: img.contentType === "image/jpeg" ? "image/jpeg" : "image/png",
        });
      } catch {
        // unreadable attachment
      }
    }
    cursorMs += Math.max(1, step.durationMs);
  }

  if (frames.length === 0 && !input.videoPath) return null;

  return {
    version: 1,
    flowName: input.flowName,
    platform: input.platform,
    startedAtIso: new Date().toISOString(),
    durationMs: Math.max(1, input.durationMs),
    viewport: input.viewport,
    frames,
    steps: markers,
    ...(input.videoPath ? { videoPath: input.videoPath } : {}),
  };
}

function extractTapPointFromStep(step: StepResult): { x: number; y: number } | undefined {
  const sel = step.selector as Record<string, unknown> | undefined;
  if (!sel || typeof sel !== "object") return undefined;
  const pt = sel["point"] as Record<string, unknown> | undefined;
  if (pt && typeof pt["x"] === "number" && typeof pt["y"] === "number") {
    return { x: pt["x"], y: pt["y"] };
  }
  return undefined;
}
