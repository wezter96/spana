import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getHealthyWarmDaemon,
  listWarmDaemons,
  registerWarmDaemon,
  stopWarmDaemon,
} from "./daemon-manager.js";
import { buildWdaLaunchArgs, findXctestrunFile } from "../drivers/wda/installer.js";
import { collectDoctorReport } from "../cli/doctor-command.js";

describe("Warm daemon manager & prebuilt WDA xctestrun", () => {
  test("registers, reuses healthy warm daemons, and prunes dead ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-daemon-test-"));
    const stateFile = join(dir, "daemons.json");

    try {
      registerWarmDaemon(
        {
          kind: "wda",
          deviceId: "SIM-UDID-1",
          host: "localhost",
          port: 8100,
          pid: 999999,
          xctestrunPath: "/tmp/WDA.xctestrun",
          startedAt: new Date().toISOString(),
        },
        stateFile,
      );

      expect(listWarmDaemons(stateFile)).toHaveLength(1);

      const healthy = await getHealthyWarmDaemon("wda", "SIM-UDID-1", {
        stateFile,
        fetchFn: (async () =>
          new Response(JSON.stringify({ value: { ready: true } }), { status: 200 })) as any,
      });
      expect(healthy?.port).toBe(8100);
      expect(healthy?.xctestrunPath).toBe("/tmp/WDA.xctestrun");

      // Simulate daemon crash -> pruned automatically
      const dead = await getHealthyWarmDaemon("wda", "SIM-UDID-1", {
        stateFile,
        fetchFn: (async () => {
          throw new Error("ECONNREFUSED");
        }) as any,
      });
      expect(dead).toBeNull();
      expect(listWarmDaemons(stateFile)).toHaveLength(0);

      // Re-register & stop explicitly
      registerWarmDaemon(
        {
          kind: "uiautomator2",
          deviceId: "emulator-5554",
          host: "localhost",
          port: 8200,
          startedAt: new Date().toISOString(),
        },
        stateFile,
      );
      expect(stopWarmDaemon("uiautomator2", "emulator-5554", stateFile)).toBe(true);
      expect(listWarmDaemons(stateFile)).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("discovers cached *.xctestrun and builds test-without-building args", () => {
    const dir = mkdtempSync(join(tmpdir(), "spana-wda-dd-"));
    try {
      const products = join(dir, "Build", "Products");
      mkdirSync(products, { recursive: true });
      const xctestrun = join(products, "WebDriverAgentRunner_iphonesimulator18.0-arm64.xctestrun");
      writeFileSync(xctestrun, "<plist/>", "utf-8");

      expect(findXctestrunFile(dir)).toBe(xctestrun);
      const args = buildWdaLaunchArgs({
        udid: "00008110-DEVICE",
        isPhysicalDevice: true,
        derivedDataPath: dir,
        xctestrunPath: xctestrun,
      });
      expect(args).toEqual([
        "test-without-building",
        "-xctestrun",
        xctestrun,
        "-destination",
        "id=00008110-DEVICE",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("spana doctor web-first checks & matrix", () => {
  test("detects Wi-Fi-only iPhone, missing iproxy, WebView inspectability, and warm daemon ports", async () => {
    const report = await collectDoctorReport({
      platforms: ["web", "android", "ios", "electron", "electrobun"],
      probes: {
        isPortOpen: async (_host, port) => port === 8100 || port === 8200,
        commandExists: (bin) => bin !== "iproxy" && bin !== "ios_webkit_debug_proxy",
        listIOSPhysicalDevices: () => [
          { udid: "WIFI-IPHONE", name: "Anton's iPhone", connectionType: "Wi-Fi" },
        ],
        listIOSSimulators: () => [
          { udid: "SIM-1", name: "iPhone 16", state: "Booted", isAvailable: true },
        ],
        listAndroidDevices: () => [{ serial: "emulator-5554", state: "device", type: "emulator" }],
        getAndroidWebViewVersion: () => "131.0.6778.104",
        getAndroidWebViewSockets: () => [{ socketName: "webview_devtools_remote_5521", pid: 5521 }],
        listWarmDaemons: () => [
          {
            kind: "wda",
            deviceId: "SIM-1",
            host: "localhost",
            port: 8100,
            startedAt: new Date().toISOString(),
          },
        ],
        readCapacitorConfig: () =>
          `export default { android: { webContentsDebuggingEnabled: true } };`,
        checkPlaywright: async () => ({ available: true, hasElectron: true }),
        probeHttp: async () => true,
        hostOs: "darwin",
        cwd: "/tmp",
      },
    });

    // Wi-Fi-only iPhone should fail the USB transport check with an actionable fix
    const usbCheck = report.checks.find((c) => c.name === "ios-usb-transport");
    expect(usbCheck?.status).toBe("fail");
    expect(usbCheck?.fix).toContain("USB");
    expect(report.allGood).toBe(false);

    // iproxy missing warning
    const iproxyCheck = report.checks.find((c) => c.name === "ios-iproxy");
    expect(iproxyCheck?.fix).toContain("libimobiledevice");

    // Warm WDA daemon recognized on port 8100, unknown owner flagged on port 8200
    expect(report.checks.find((c) => c.name === "port-8100")?.status).toBe("ok");
    expect(report.checks.find((c) => c.name === "port-8200")?.status).toBe("warn");

    // Android WebView version & inspectable socket reported
    expect(
      report.checks.find((c) => c.name.startsWith("android-webview-version"))?.message,
    ).toContain("131.0.6778.104");
    expect(
      report.checks.find((c) => c.name.startsWith("android-webview-inspectable"))?.status,
    ).toBe("ok");

    // Capacitor config detected
    expect(report.checks.find((c) => c.name === "capacitor-webview-config")?.status).toBe("ok");

    // Matrix contains all 5 targets
    expect(report.matrix.map((m) => m.platform)).toEqual([
      "web",
      "android",
      "ios",
      "electron",
      "electrobun",
    ]);
  });
});
