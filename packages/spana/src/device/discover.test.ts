import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const discoverState = {
  versionCandidates: new Set<string>(),
  androidDevicesOutput: "",
  iosDevicesJson: JSON.stringify({ devices: {} }),
};

let moduleCounter = 0;

function resetDiscoverState(): void {
  discoverState.versionCandidates.clear();
  discoverState.androidDevicesOutput = "";
  discoverState.iosDevicesJson = JSON.stringify({ devices: {} });
}

function registerChildProcessMock(): void {
  mock.module("node:child_process", () => ({
    execSync: (command: string) => {
      if (command.endsWith(" version")) {
        const candidate = command.slice(0, -8);
        if (discoverState.versionCandidates.has(candidate)) {
          return "Android Debug Bridge version";
        }
        throw new Error("missing adb");
      }

      if (command.endsWith(" devices")) {
        return discoverState.androidDevicesOutput;
      }

      if (command === "xcrun simctl list devices -j") {
        return discoverState.iosDevicesJson;
      }

      throw new Error(`unexpected command: ${command}`);
    },
    execFileSync: () => "",
  }));
}

async function importFreshModule<T>(path: string): Promise<T> {
  moduleCounter += 1;
  return (await import(new URL(`${path}?case=${moduleCounter}`, import.meta.url).href)) as T;
}

describe("device discovery", () => {
  beforeEach(() => {
    mock.restore();
    resetDiscoverState();
    registerChildProcessMock();
  });

  afterEach(() => {
    mock.restore();
  });

  test("discovers browser, android, and booted ios targets", async () => {
    discoverState.versionCandidates.add("adb");
    discoverState.androidDevicesOutput = [
      "List of devices attached",
      "emulator-5554 device",
      "usb-9 offline",
      "",
    ].join("\n");
    discoverState.iosDevicesJson = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          { udid: "SIM-1", name: "iPhone 15", state: "Booted", isAvailable: true },
          { udid: "SIM-2", name: "iPhone 14", state: "Shutdown", isAvailable: true },
        ],
      },
    });

    const androidModule = await importFreshModule<typeof import("./android.js")>("./android.ts");
    const iosModule = await importFreshModule<typeof import("./ios.js")>("./ios.ts");
    mock.module("./android.js", () => androidModule);
    mock.module("./ios.js", () => iosModule);
    const discover = await importFreshModule<typeof import("./discover.js")>("./discover.ts");

    expect(discover.discoverDevices(["web", "android", "ios"])).toEqual([
      {
        platform: "web",
        id: "playwright-chromium",
        name: "Chromium (Playwright)",
        type: "browser",
        state: "available",
      },
      {
        platform: "android",
        id: "emulator-5554",
        name: "emulator-5554",
        type: "emulator",
        state: "device",
      },
      {
        platform: "ios",
        id: "SIM-1",
        name: "iPhone 15 (iOS.18.0)",
        type: "simulator",
        state: "Booted",
      },
    ]);
  });

  test("returns the first discovered device for a platform or null", async () => {
    discoverState.versionCandidates.add("adb");
    discoverState.androidDevicesOutput = ["List of devices attached", "device-1 device", ""].join(
      "\n",
    );

    const androidModule = await importFreshModule<typeof import("./android.js")>("./android.ts");
    const iosModule = await importFreshModule<typeof import("./ios.js")>("./ios.ts");
    mock.module("./android.js", () => androidModule);
    mock.module("./ios.js", () => iosModule);
    const discover = await importFreshModule<typeof import("./discover.js")>("./discover.ts");

    expect(discover.firstDeviceForPlatform("android")).toEqual({
      platform: "android",
      id: "device-1",
      name: "device-1",
      type: "device",
      state: "device",
    });
    expect(discover.firstDeviceForPlatform("ios")).toBeNull();
  });

  test("findDeviceById returns matching device", async () => {
    discoverState.versionCandidates.add("adb");
    discoverState.androidDevicesOutput = [
      "List of devices attached",
      "emulator-5554 device",
      "",
    ].join("\n");
    discoverState.iosDevicesJson = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          { udid: "SIM-1", name: "iPhone 15", state: "Booted", isAvailable: true },
        ],
      },
    });

    const androidModule = await importFreshModule<typeof import("./android.js")>("./android.ts");
    const iosModule = await importFreshModule<typeof import("./ios.js")>("./ios.ts");
    mock.module("./android.js", () => androidModule);
    mock.module("./ios.js", () => iosModule);
    const discover = await importFreshModule<typeof import("./discover.js")>("./discover.ts");

    expect(discover.findDeviceById("emulator-5554")).toEqual({
      platform: "android",
      id: "emulator-5554",
      name: "emulator-5554",
      type: "emulator",
      state: "device",
    });

    expect(discover.findDeviceById("SIM-1")).toEqual({
      platform: "ios",
      id: "SIM-1",
      name: "iPhone 15 (iOS.18.0)",
      type: "simulator",
      state: "Booted",
    });

    expect(discover.findDeviceById("nonexistent")).toBeNull();
  });
});
