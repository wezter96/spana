import { describe, expect, it } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { Effect } from "effect";
import {
  buildPlaybackTraceFromSteps,
  startAndroidVideoRecorder,
  startCdpScreencastRecorder,
  startIosSimulatorVideoRecorder,
  type CdpScreencastLike,
  type FlowPlaybackTrace,
} from "./video-recorder.js";
import { createHtmlReporter } from "../report/html.js";
import { executeFlow } from "./engine.js";
import { flow } from "../api/flow.js";
import type { RawDriverService } from "../drivers/raw-driver.js";

// Tiny valid 1x1 PNG bytes for test frames
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function createMockCdp(): {
  cdp: CdpScreencastLike;
  commands: Array<{ method: string; params?: Record<string, unknown> }>;
  emit: (method: string, params: any) => void;
} {
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const listeners = new Map<string, Set<(params: any, sid?: string) => void>>();

  const cdp: CdpScreencastLike = {
    async sendCommand(method, params) {
      commands.push({ method, params });
      return {} as any;
    },
    onEvent(method, listener) {
      let set = listeners.get(method);
      if (!set) {
        set = new Set();
        listeners.set(method, set);
      }
      set.add(listener);
      return () => {
        set?.delete(listener);
      };
    },
  };

  return {
    cdp,
    commands,
    emit(method, params) {
      for (const fn of listeners.get(method) ?? []) {
        fn(params);
      }
    },
  };
}

function createFakeChildProcess(): ChildProcess & { killedSignal?: string } {
  const ee = new EventEmitter() as ChildProcess & { killedSignal?: string };
  ee.kill = ((signal?: NodeJS.Signals | number) => {
    ee.killedSignal = typeof signal === "string" ? signal : String(signal ?? "SIGTERM");
    setImmediate(() => ee.emit("close", 0));
    return true;
  }) as any;
  return ee;
}

describe("video-recorder", () => {
  it("captures CDP screencast frames, acks each frame, and writes playback trace when kept", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-vid-test-"));
    try {
      const mock = createMockCdp();
      const handle = await startCdpScreencastRecorder(mock.cdp, {
        flowName: "checkout flow",
        platform: "web",
        exportMp4: false,
      });

      expect(mock.commands.some((c) => c.method === "Page.startScreencast")).toBe(true);

      mock.emit("Page.screencastFrame", { sessionId: 101, data: TINY_PNG_BASE64 });
      mock.emit("Page.screencastFrame", { sessionId: 102, data: TINY_PNG_BASE64 });

      const acks = mock.commands.filter((c) => c.method === "Page.screencastFrameAck");
      expect(acks).toHaveLength(2);
      expect(acks[0]?.params).toEqual({ sessionId: 101 });
      expect(acks[1]?.params).toEqual({ sessionId: 102 });

      const res = await handle.stop({
        keep: true,
        outputDir: tmp,
        fileStem: "checkout_flow",
        viewport: { width: 1280, height: 720 },
        steps: [
          {
            index: 0,
            command: "tap",
            startedAtMs: 0,
            durationMs: 42,
            status: "passed",
            tapPoint: { x: 320, y: 240 },
          },
        ],
      });

      expect(mock.commands.some((c) => c.method === "Page.stopScreencast")).toBe(true);
      expect(res.frameCount).toBe(2);
      expect(res.playbackJsonPath).toBe(join(tmp, "checkout_flow-playback.json"));
      expect(existsSync(res.playbackJsonPath!)).toBe(true);

      const trace = JSON.parse(readFileSync(res.playbackJsonPath!, "utf8")) as FlowPlaybackTrace;
      expect(trace.version).toBe(1);
      expect(trace.frames).toHaveLength(2);
      expect(trace.steps[0]?.tapPoint).toEqual({ x: 320, y: 240 });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("discards CDP frames when keep=false (retain-on-failure passed flow)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-vid-discard-"));
    try {
      const mock = createMockCdp();
      const handle = await startCdpScreencastRecorder(mock.cdp, {
        flowName: "passing flow",
        platform: "web",
        exportMp4: false,
      });

      mock.emit("Page.screencastFrame", { sessionId: 1, data: TINY_PNG_BASE64 });
      const res = await handle.stop({
        keep: false,
        outputDir: tmp,
        fileStem: "passing_flow",
      });

      expect(res.frameCount).toBe(0);
      expect(res.playbackJsonPath).toBeUndefined();
      expect(existsSync(join(tmp, "passing_flow-playback.json"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("starts and stops Android adb screenrecord and pulls mp4 when kept", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-vid-android-"));
    try {
      const outPath = join(tmp, "android-flow.mp4");
      const fakeChild = createFakeChildProcess();
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];
      const execCalls: Array<{ cmd: string; args: string[] }> = [];

      const handle = startAndroidVideoRecorder("emulator-5554", {
        outputPath: outPath,
        spawnFn: ((cmd: string, args: string[]) => {
          spawnCalls.push({ cmd, args });
          return fakeChild;
        }) as any,
        execFileSyncFn: ((cmd: string, args: string[]) => {
          execCalls.push({ cmd, args });
          if (args.includes("pull")) {
            writeFileSync(outPath, Buffer.from("fake-mp4-bytes"));
          }
          return Buffer.alloc(0);
        }) as any,
      });

      expect(spawnCalls[0]?.cmd).toBe("adb");
      expect(spawnCalls[0]?.args).toContain("screenrecord");

      const res = await handle.stop({
        keep: true,
        outputDir: tmp,
        fileStem: "android-flow",
      });

      expect(fakeChild.killedSignal).toBe("SIGINT");
      expect(res.videoPath).toBe(outPath);
      expect(execCalls.some((c) => c.args.includes("pull"))).toBe(true);
      expect(execCalls.some((c) => c.args.includes("rm"))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("starts and stops iOS simulator recordVideo and cleans up when keep=false", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-vid-ios-"));
    try {
      const outPath = join(tmp, "ios-flow.mp4");
      writeFileSync(outPath, Buffer.from("fake-ios-mp4"));
      const fakeChild = createFakeChildProcess();
      const spawnCalls: Array<{ cmd: string; args: string[] }> = [];

      const handle = startIosSimulatorVideoRecorder("SIM-UDID-123", {
        outputPath: outPath,
        spawnFn: ((cmd: string, args: string[]) => {
          spawnCalls.push({ cmd, args });
          return fakeChild;
        }) as any,
      });

      expect(spawnCalls[0]?.cmd).toBe("xcrun");
      expect(spawnCalls[0]?.args).toContain("recordVideo");

      const res = await handle.stop({
        keep: false,
        outputDir: tmp,
        fileStem: "ios-flow",
      });

      expect(fakeChild.killedSignal).toBe("SIGINT");
      expect(res.videoPath).toBeUndefined();
      expect(existsSync(outPath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("builds fallback playback trace from step screenshots and renders interactive player in report.html", () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-vid-html-"));
    try {
      const shotPath = join(tmp, "step-1.png");
      const mp4Path = join(tmp, "flow.mp4");
      writeFileSync(shotPath, Buffer.from(TINY_PNG_BASE64, "base64"));
      writeFileSync(mp4Path, Buffer.from("fake-mp4-data"));

      const trace = buildPlaybackTraceFromSteps({
        flowName: "login playback",
        platform: "web",
        durationMs: 420,
        viewport: { width: 1280, height: 720 },
        videoPath: mp4Path,
        steps: [
          {
            command: "tap",
            selector: { point: { x: 400, y: 200 } },
            durationMs: 120,
            status: "passed",
            attachments: [{ name: "step-1", contentType: "image/png", path: shotPath }],
          },
          {
            command: "assertVisible",
            selector: { text: "Welcome" },
            durationMs: 300,
            status: "passed",
          },
        ],
      });

      expect(trace).not.toBeNull();
      expect(trace!.frames).toHaveLength(1);
      expect(trace!.steps[0]?.tapPoint).toEqual({ x: 400, y: 200 });

      const playbackJsonPath = join(tmp, "login_playback-playback.json");
      writeFileSync(playbackJsonPath, JSON.stringify(trace), "utf8");

      const reporter = createHtmlReporter(tmp);
      reporter.onRunComplete({
        total: 1,
        passed: 1,
        failed: 0,
        skipped: 0,
        flaky: 0,
        durationMs: 420,
        platforms: ["web"],
        results: [
          {
            name: "login playback",
            platform: "web",
            status: "passed",
            durationMs: 420,
            attachments: [
              { name: "playback", contentType: "application/json", path: playbackJsonPath },
              { name: "video", contentType: "video/mp4", path: mp4Path },
            ],
          },
        ],
      });

      const html = readFileSync(join(tmp, "report.html"), "utf8");
      expect(html).toContain("Visual playback (1 frames)");
      expect(html).toContain('data-action="toggle"');
      expect(html).toContain('class="pb-scrubber"');
      expect(html).toContain('class="pb-ripple"');
      expect(html).toContain("<video controls");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("executeFlow automatically records CDP screencast and attaches playback trace when playback=true", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "spana-engine-pb-"));
    try {
      const mockCdp = createMockCdp();
      const fakeDriver = {
        domChannel: mockCdp.cdp as any,
        getDeviceInfo: () =>
          Effect.succeed({
            deviceId: "cdp-web-1",
            name: "Chromium",
            platform: "web" as const,
            isEmulator: false,
            screenWidth: 1280,
            screenHeight: 720,
            driverType: "playwright" as const,
          }),
        launchApp: () => Effect.void,
        takeScreenshot: () => Effect.succeed(Buffer.from(TINY_PNG_BASE64, "base64")),
        getHierarchy: () => Effect.succeed("[]"),
        tap: () => Effect.void,
        doubleTap: () => Effect.void,
        longPress: () => Effect.void,
        swipe: () => Effect.void,
        inputText: () => Effect.void,
        clearText: () => Effect.void,
        pressKey: () => Effect.void,
        terminateApp: () => Effect.void,
        openUrl: () => Effect.void,
        setOrientation: () => Effect.void,
      } as unknown as RawDriverService;

      const testFlow = flow("recorded flow", async () => {
        mockCdp.emit("Page.screencastFrame", { sessionId: 7, data: TINY_PNG_BASE64 });
      });

      const res = await executeFlow(testFlow, fakeDriver, {
        appId: "https://example.test",
        platform: "web",
        autoLaunch: false,
        coordinatorConfig: {
          parse: () => ({ bounds: { x: 0, y: 0, width: 1280, height: 720 } }),
        },
        artifactConfig: {
          outputDir: tmp,
          playback: true,
          video: "off",
        },
      });

      expect(res.status).toBe("passed");
      const pbAtt = res.attachments?.find((a) => a.name === "playback");
      expect(pbAtt).toBeDefined();
      expect(existsSync(pbAtt!.path)).toBe(true);
      const parsed = JSON.parse(readFileSync(pbAtt!.path, "utf8")) as FlowPlaybackTrace;
      expect(parsed.frames).toHaveLength(1);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
