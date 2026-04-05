import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import type { DeviceInfo } from "../schemas/device.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import { captureArtifacts, captureStepScreenshot, resolveArtifactConfig } from "./artifacts.js";

const tempDir = mkdtempSync(join(tmpdir(), "spana-artifacts-"));

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function createDriver(overrides: Partial<RawDriverService> = {}): RawDriverService {
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
    takeScreenshot: () => Effect.succeed(new Uint8Array([1, 2, 3])),
    getDeviceInfo: () => Effect.succeed(deviceInfo),
    launchApp: () => Effect.void,
    stopApp: () => Effect.void,
    killApp: () => Effect.void,
    clearAppState: () => Effect.void,
    openLink: () => Effect.void,
    back: () => Effect.void,
    ...overrides,
  };
}

describe("artifacts", () => {
  test("resolveArtifactConfig merges overrides over defaults", () => {
    expect(
      resolveArtifactConfig({ captureOnSuccess: true, outputDir: "first" }, undefined, {
        screenshot: false,
        outputDir: "final",
      }),
    ).toEqual({
      outputDir: "final",
      captureOnFailure: true,
      captureOnSuccess: true,
      captureSteps: false,
      screenshot: false,
      uiHierarchy: true,
    });
  });

  test("captureArtifacts writes screenshot and hierarchy files", async () => {
    const driver = createDriver();
    const config = resolveArtifactConfig({
      outputDir: join(tempDir, "capture"),
      captureOnFailure: true,
      screenshot: true,
      uiHierarchy: true,
    });

    const attachments = await captureArtifacts(driver, config, "Flow / Name", "web", "failed");

    expect(attachments).toHaveLength(2);
    expect(attachments.map((attachment) => attachment.name)).toEqual([
      "failed-screenshot",
      "failed-hierarchy",
    ]);
    expect(readFileSync(attachments[1]!.path, "utf8")).toBe('{"tree":true}');
  });

  test("captureStepScreenshot uses the provided bytes and names files safely", async () => {
    const attachment = await captureStepScreenshot(
      createDriver(),
      resolveArtifactConfig({ outputDir: join(tempDir, "steps") }),
      "Flow / Name",
      "web",
      7,
      "take screenshot / home",
      new Uint8Array([9, 8, 7]),
    );

    expect(attachment?.name).toBe("take screenshot / home");
    expect(attachment?.path).toContain("007-take_screenshot_home.png");
    expect(attachment ? existsSync(attachment.path) : false).toBe(true);
    expect(attachment ? Array.from(readFileSync(attachment.path)) : []).toEqual([9, 8, 7]);
  });
});
