import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = { ...require("node:fs") } as typeof import("node:fs");

const discoverState = {
  versionCandidates: new Set<string>(),
  androidDevicesOutput: "",
  iosDevicesJson: JSON.stringify({ devices: {} }),
  iosPhysicalDevicesJson: JSON.stringify({ result: { devices: [] } }),
  lastDevicectlPath: "",
};

let moduleCounter = 0;

function resetDiscoverState(): void {
  discoverState.versionCandidates.clear();
  discoverState.androidDevicesOutput = "";
  discoverState.iosDevicesJson = JSON.stringify({ devices: {} });
  discoverState.iosPhysicalDevicesJson = JSON.stringify({ result: { devices: [] } });
  discoverState.lastDevicectlPath = "";
}

function registerChildProcessMock(): void {
  mock.module("node:child_process", () => ({
    execSync: () => "",
    spawn: () => ({ unref: () => {}, kill: () => {} }),
    execFileSync: (command: string, args: string[]) => {
      const full = `${command} ${args.join(" ")}`;

      if (args.length === 1 && args[0] === "version") {
        if (discoverState.versionCandidates.has(command)) {
          return "Android Debug Bridge version";
        }
        throw new Error("missing adb");
      }

      if (args.length === 1 && args[0] === "devices") {
        return discoverState.androidDevicesOutput;
      }

      if (full === "xcrun simctl list devices -j") {
        return discoverState.iosDevicesJson;
      }

      if (command === "xcrun" && args[0] === "devicectl" && args[1] === "list") {
        const outIdx = args.indexOf("--json-output");
        discoverState.lastDevicectlPath =
          outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : "/tmp/spana-devicectl-test.json";
        return "";
      }

      throw new Error(`unexpected command: ${full}`);
    },
  }));

  mock.module("node:fs", () => ({
    ...realFs,
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      if (path === discoverState.lastDevicectlPath) {
        return discoverState.iosPhysicalDevicesJson;
      }

      return realFs.readFileSync(path, encoding as never);
    },
    unlinkSync: () => undefined,
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

  test("discovers browser, android, connected ios devices, and available simulators", async () => {
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
    discoverState.iosPhysicalDevicesJson = JSON.stringify({
      result: {
        devices: [
          {
            identifier: "PHONE-1",
            hardwareProperties: { deviceType: "iPhone", udid: "PHONE-1" },
            deviceProperties: { name: "USB iPhone" },
            connectionProperties: {
              transportType: "wired",
              tunnelState: "connected",
            },
          },
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
        id: "PHONE-1",
        name: "USB iPhone",
        type: "device",
        state: "connected",
      },
      {
        platform: "ios",
        id: "SIM-1",
        name: "iPhone 15 (iOS.18.0)",
        type: "simulator",
        state: "Booted",
      },
      {
        platform: "ios",
        id: "SIM-2",
        name: "iPhone 14 (iOS.18.0)",
        type: "simulator",
        state: "Shutdown",
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
    discoverState.iosPhysicalDevicesJson = JSON.stringify({
      result: {
        devices: [
          {
            identifier: "PHONE-1",
            hardwareProperties: { deviceType: "iPhone", udid: "PHONE-1" },
            deviceProperties: { name: "USB iPhone" },
            connectionProperties: {
              transportType: "wired",
              tunnelState: "connected",
            },
          },
        ],
      },
    });

    const androidModule = await importFreshModule<typeof import("./android.js")>("./android.ts");
    const iosModule = await importFreshModule<typeof import("./ios.js")>("./ios.ts");
    mock.module("./android.js", () => androidModule);
    mock.module("./ios.js", () => iosModule);
    const discover = await importFreshModule<typeof import("./discover.js")>("./discover.ts");

    expect(discover.findDeviceById("PHONE-1")).toEqual({
      platform: "ios",
      id: "PHONE-1",
      name: "USB iPhone",
      type: "device",
      state: "connected",
    });

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
