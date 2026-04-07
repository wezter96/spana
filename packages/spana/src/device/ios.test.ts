import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = { ...require("node:fs") } as typeof import("node:fs");

const iosState = {
  listDevicesJson: JSON.stringify({ devices: {} }),
  devicectlJson: JSON.stringify({ result: { devices: [] } }),
  installedApps: new Set<string>(),
  plistJson: JSON.stringify([]),
  bootShouldThrow: false,
  terminateShouldThrow: false,
  devicectlShouldThrow: false,
  lastDevicectlPath: "",
  execSyncCalls: [] as string[],
  execFileCalls: [] as Array<{ command: string; args: string[] }>,
};

let importCounter = 0;

function resetIOSState(): void {
  iosState.listDevicesJson = JSON.stringify({ devices: {} });
  iosState.devicectlJson = JSON.stringify({ result: { devices: [] } });
  iosState.installedApps.clear();
  iosState.plistJson = JSON.stringify([]);
  iosState.bootShouldThrow = false;
  iosState.terminateShouldThrow = false;
  iosState.devicectlShouldThrow = false;
  iosState.lastDevicectlPath = "";
  iosState.execSyncCalls = [];
  iosState.execFileCalls = [];
}

function registerIOSMocks(): void {
  mock.module("node:child_process", () => ({
    execSync: (command: string) => {
      iosState.execSyncCalls.push(command);

      if (command === "xcrun simctl list devices -j") {
        return iosState.listDevicesJson;
      }

      if (command.startsWith("xcrun devicectl list devices --json-output ")) {
        if (iosState.devicectlShouldThrow) {
          throw new Error("missing devicectl");
        }

        iosState.lastDevicectlPath =
          command.match(/--json-output\s+(\S+)/)?.[1] ?? "/tmp/spana-devicectl-test.json";
        return "";
      }

      if (command.startsWith("xcrun simctl get_app_container ")) {
        const [, , , udid, bundleId] = command.split(" ");
        if (iosState.installedApps.has(`${udid}:${bundleId}`)) {
          return "/Applications/App.app";
        }
        throw new Error("missing app");
      }

      if (command.startsWith("xcrun simctl boot ")) {
        if (iosState.bootShouldThrow) {
          throw new Error("already booted");
        }
        return "";
      }

      if (command.startsWith("xcrun simctl terminate ")) {
        if (iosState.terminateShouldThrow) {
          throw new Error("not running");
        }
        return "";
      }

      return "";
    },
    execFileSync: (command: string, args: string[]) => {
      iosState.execFileCalls.push({ command, args });

      if (command === "plutil") {
        return iosState.plistJson;
      }

      return "";
    },
  }));

  mock.module("node:fs", () => ({
    ...realFs,
    readFileSync: (path: string, encoding?: BufferEncoding) => {
      if (path === iosState.lastDevicectlPath) {
        return iosState.devicectlJson;
      }

      return realFs.readFileSync(path, encoding as never);
    },
    unlinkSync: () => undefined,
  }));
}

async function importFreshIOS() {
  importCounter += 1;
  return (await import(
    new URL(`./ios.ts?case=${importCounter}`, import.meta.url).href
  )) as typeof import("./ios.js");
}

describe("ios device helpers", () => {
  beforeEach(() => {
    mock.restore();
    resetIOSState();
    registerIOSMocks();
  });

  afterEach(() => {
    mock.restore();
  });

  test("lists simulators and prefers a booted simulator with the app installed", async () => {
    iosState.listDevicesJson = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-17-5": [
          { udid: "SIM-BOOTED", name: "iPhone 15", state: "Booted", isAvailable: true },
          { udid: "SIM-SHUTDOWN", name: "iPhone 14", state: "Shutdown", isAvailable: true },
        ],
      },
    });
    iosState.installedApps.add("SIM-BOOTED:com.example.shop");

    const ios = await importFreshIOS();

    expect(ios.listIOSSimulators()).toEqual([
      {
        udid: "SIM-BOOTED",
        name: "iPhone 15",
        state: "Booted",
        runtime: "iOS.17.5",
        isAvailable: true,
      },
      {
        udid: "SIM-SHUTDOWN",
        name: "iPhone 14",
        state: "Shutdown",
        runtime: "iOS.17.5",
        isAvailable: true,
      },
    ]);
    expect(ios.listBootedSimulators()).toEqual([
      {
        udid: "SIM-BOOTED",
        name: "iPhone 15",
        state: "Booted",
        runtime: "iOS.17.5",
        isAvailable: true,
      },
    ]);
    expect(ios.firstIOSSimulatorWithApp("com.example.shop")?.udid).toBe("SIM-BOOTED");
  });

  test("falls back to an available simulator and reads installed URL schemes", async () => {
    iosState.listDevicesJson = JSON.stringify({
      devices: {
        "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
          { udid: "SIM-BOOTED", name: "iPhone 15", state: "Booted", isAvailable: true },
          { udid: "SIM-WITH-APP", name: "iPhone 16", state: "Shutdown", isAvailable: true },
        ],
      },
    });
    iosState.installedApps.add("SIM-WITH-APP:com.example.shop");
    iosState.plistJson = JSON.stringify([{ CFBundleURLSchemes: ["spana", "https"] }]);

    const ios = await importFreshIOS();

    expect(ios.firstIOSSimulatorWithApp("com.example.shop")).toEqual({
      udid: "SIM-WITH-APP",
      name: "iPhone 16",
      state: "Shutdown",
      runtime: "iOS.18.0",
      isAvailable: true,
    });
    expect(ios.installedUrlSchemesOnSimulator("SIM-WITH-APP", "com.example.shop")).toEqual([
      "spana",
      "https",
    ]);
  });

  test("swallows expected boot and terminate errors while still issuing url commands", async () => {
    iosState.bootShouldThrow = true;
    iosState.terminateShouldThrow = true;
    const ios = await importFreshIOS();

    expect(() => ios.bootSimulator("SIM-1")).not.toThrow();
    expect(() => ios.terminateOnSimulator("SIM-1", "com.example.shop")).not.toThrow();
    ios.openUrlOnSimulator("SIM-1", "spana://checkout");
    ios.launchWithUrlOnSimulator("SIM-1", "com.example.shop", "spana://checkout");

    expect(iosState.execFileCalls).toEqual([
      {
        command: "xcrun",
        args: ["simctl", "openurl", "SIM-1", "spana://checkout"],
      },
      {
        command: "xcrun",
        args: ["simctl", "launch", "SIM-1", "com.example.shop", "--open-url", "spana://checkout"],
      },
    ]);
  });

  test("lists only currently connected physical iOS devices from devicectl", async () => {
    iosState.devicectlJson = JSON.stringify({
      result: {
        devices: [
          {
            identifier: "IOS-DISCONNECTED",
            hardwareProperties: { deviceType: "iPhone", udid: "IOS-DISCONNECTED" },
            deviceProperties: { name: "Remembered iPhone" },
            connectionProperties: {
              transportType: "localNetwork",
              tunnelState: "disconnected",
            },
          },
          {
            identifier: "IOS-CONNECTED",
            hardwareProperties: { deviceType: "iPad", udid: "IOS-CONNECTED" },
            deviceProperties: { name: "Connected iPad" },
            connectionProperties: {
              transportType: "wired",
              tunnelState: "connected",
            },
          },
          {
            identifier: "IOS-UNAVAILABLE",
            hardwareProperties: { deviceType: "iPhone", udid: "IOS-UNAVAILABLE" },
            deviceProperties: { name: "Unavailable iPhone" },
            connectionProperties: {
              transportType: "wired",
              tunnelState: "unavailable",
            },
          },
        ],
      },
    });

    const ios = await importFreshIOS();

    expect(ios.listIOSPhysicalDevices()).toEqual([
      {
        udid: "IOS-CONNECTED",
        name: "Connected iPad",
        connectionType: "USB",
      },
    ]);
    expect(ios.firstIOSPhysicalDevice()).toEqual({
      udid: "IOS-CONNECTED",
      name: "Connected iPad",
      connectionType: "USB",
    });
  });
});
