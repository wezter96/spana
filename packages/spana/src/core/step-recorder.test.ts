import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { DeviceInfo } from "../schemas/device.js";
import { createStepRecorder } from "./step-recorder.js";
import { resolveArtifactConfig } from "./artifacts.js";

const tempDir = mkdtempSync(join(tmpdir(), "spana-step-recorder-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createDriver(): RawDriverService {
  const deviceInfo: DeviceInfo = {
    platform: "web",
    deviceId: "playwright",
    name: "Chromium",
    isEmulator: false,
    screenWidth: 1280,
    screenHeight: 720,
    driverType: "playwright",
  };

  return {
    dumpHierarchy: () => Effect.succeed('{"tree":true}'),
    tapAtCoordinate: () => Effect.void,
    doubleTapAtCoordinate: () => Effect.void,
    longPressAtCoordinate: () => Effect.void,
    swipe: () => Effect.void,
    inputText: () => Effect.void,
    pressKey: () => Effect.void,
    hideKeyboard: () => Effect.void,
    takeScreenshot: () => Effect.succeed(new Uint8Array([7, 8, 9])),
    getDeviceInfo: () => Effect.succeed(deviceInfo),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
  };
}

describe("step recorder", () => {
  test("runStep records passed steps and optional screenshot attachments", async () => {
    const recorder = createStepRecorder(
      createDriver(),
      resolveArtifactConfig({
        outputDir: join(tempDir, "passed"),
        captureSteps: true,
      }),
      "Flow Name",
      "web",
    );

    const result = await recorder.runStep("tap", async () => "done", {
      selector: { text: "Save" },
      captureScreenshot: true,
    });

    expect(result).toBe("done");

    const [step] = recorder.getSteps();
    expect(step).toMatchObject({
      command: "tap",
      selector: { text: "Save" },
      status: "passed",
    });
    expect(step?.attachments).toHaveLength(1);
    expect(step?.attachments?.[0]?.name).toBe("tap");
    expect(step?.attachments?.[0]?.path).toContain("001-tap.png");
    expect(step?.attachments?.[0] ? existsSync(step.attachments[0].path) : false).toBe(true);
  });

  test("runStep records failures and stringifies thrown values", async () => {
    const recorder = createStepRecorder(
      createDriver(),
      resolveArtifactConfig({
        outputDir: join(tempDir, "failed"),
      }),
      "Flow Name",
      "web",
    );

    let thrown: unknown;
    try {
      await recorder.runStep("explode", async () => {
        throw "boom";
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBe("boom");
    expect(recorder.getSteps()).toEqual([
      expect.objectContaining({
        command: "explode",
        status: "failed",
        error: "boom",
      }),
    ]);
  });

  test("runScreenshotStep stores provided bytes with a custom attachment name", async () => {
    const recorder = createStepRecorder(
      createDriver(),
      resolveArtifactConfig({
        outputDir: join(tempDir, "screenshots"),
      }),
      "Flow Name",
      "web",
    );
    const screenshot = new Uint8Array([9, 8, 7]);

    const returned = await recorder.runScreenshotStep("takeScreenshot", async () => screenshot, {
      name: "home screen",
    });

    expect(returned).toBe(screenshot);

    const [step] = recorder.getSteps();
    expect(step).toMatchObject({
      command: "takeScreenshot",
      status: "passed",
    });
    expect(step?.attachments).toHaveLength(1);
    expect(step?.attachments?.[0]?.name).toBe("home screen");
    expect(step?.attachments?.[0]?.path).toContain("001-home_screen.png");
    expect(
      step?.attachments?.[0] ? Array.from(readFileSync(step.attachments[0].path)) : [],
    ).toEqual([9, 8, 7]);
  });
});
