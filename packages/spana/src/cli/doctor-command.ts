import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { resolve } from "node:path";
import type { ProvConfig } from "../schemas/config.js";
import type { Platform } from "../schemas/selector.js";
import {
  formatTargetMatrixTable,
  resolveTargetDescriptor,
  type HostOS,
  type TargetDescriptor,
} from "../core/target-matrix.js";
import { discoverAndroidWebViewSockets } from "../channels/android-cdp.js";
import { isWebKitDebugProxyInstalled } from "../channels/webkit-inspector.js";
import { listWarmDaemons, type WarmDaemonRecord } from "../runtime/daemon-manager.js";
import { resolveElectrobunLaunchPlan } from "../drivers/electrobun.js";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorOptions {
  configPath?: string;
  platforms: Platform[];
  driver?: "local" | "appium";
  appiumUrl?: string;
  capsPath?: string;
  capsJson?: string;
  json: boolean;
  pretty: boolean;
  /** Injectable probes for unit testing */
  probes?: Partial<DoctorProbes>;
}

export interface DoctorProbes {
  isPortOpen: (host: string, port: number) => Promise<boolean>;
  commandExists: (bin: string) => boolean;
  listIOSPhysicalDevices: () => Array<{ udid: string; name: string; connectionType: string }>;
  listIOSSimulators: () => Array<{
    udid: string;
    name: string;
    state: string;
    isAvailable: boolean;
  }>;
  listAndroidDevices: () => Array<{ serial: string; state: string; type: "emulator" | "device" }>;
  getAndroidWebViewVersion: (serial: string) => string | null;
  getAndroidWebViewSockets: (serial: string) => Array<{ socketName: string; pid?: number }>;
  listWarmDaemons: () => WarmDaemonRecord[];
  readCapacitorConfig: (cwd: string) => string | null;
  checkPlaywright: () => Promise<{ available: boolean; hasElectron: boolean }>;
  probeHttp: (url: string) => Promise<boolean>;
  hostOs: HostOS;
  cwd: string;
}

async function defaultIsPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolveOpen) => {
    const socket = createConnection({ host, port });
    const done = (open: boolean) => {
      socket.destroy();
      resolveOpen(open);
    };
    socket.setTimeout(350);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function defaultCommandExists(bin: string): boolean {
  try {
    execFileSync("which", [bin], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function defaultGetAndroidWebViewVersion(serial: string): string | null {
  try {
    const out = execFileSync(
      "adb",
      ["-s", serial, "shell", "dumpsys", "package", "com.google.android.webview"],
      {
        encoding: "utf-8",
        timeout: 4000,
      },
    );
    const match = out.match(/versionName=([^\s]+)/);
    if (match?.[1]) return match[1];
  } catch {
    // try Chrome (Android 7-9 / Trichrome)
  }
  try {
    const out = execFileSync(
      "adb",
      ["-s", serial, "shell", "dumpsys", "package", "com.android.chrome"],
      {
        encoding: "utf-8",
        timeout: 4000,
      },
    );
    const match = out.match(/versionName=([^\s]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

function defaultReadCapacitorConfig(cwd: string): string | null {
  for (const name of ["capacitor.config.ts", "capacitor.config.js", "capacitor.config.json"]) {
    const full = resolve(cwd, name);
    if (existsSync(full)) {
      try {
        return readFileSync(full, "utf-8");
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function defaultProbeHttp(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 500);
    try {
      const res = await fetch(url, { signal: controller.signal });
      return res.ok || res.status === 426;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

async function buildDefaultProbes(): Promise<DoctorProbes> {
  const { listIOSPhysicalDevices, listIOSSimulators } = await import("../device/ios.js");
  const { listAndroidDevices } = await import("../device/android.js");

  return {
    isPortOpen: defaultIsPortOpen,
    commandExists: defaultCommandExists,
    listIOSPhysicalDevices,
    listIOSSimulators,
    listAndroidDevices,
    getAndroidWebViewVersion: defaultGetAndroidWebViewVersion,
    getAndroidWebViewSockets: (serial) => {
      try {
        return discoverAndroidWebViewSockets(serial);
      } catch {
        return [];
      }
    },
    listWarmDaemons: () => listWarmDaemons(),
    readCapacitorConfig: defaultReadCapacitorConfig,
    checkPlaywright: async () => {
      try {
        const pw = await import("playwright-core");
        return { available: true, hasElectron: Boolean(pw._electron) };
      } catch {
        return { available: false, hasElectron: false };
      }
    },
    probeHttp: defaultProbeHttp,
    hostOs:
      process.platform === "win32" ? "win32" : process.platform === "linux" ? "linux" : "darwin",
    cwd: process.cwd(),
  };
}

export interface DoctorReport {
  allGood: boolean;
  checks: DoctorCheck[];
  matrix: TargetDescriptor[];
  warmDaemons: WarmDaemonRecord[];
}

export async function collectDoctorReport(
  options: Pick<DoctorOptions, "configPath" | "platforms" | "probes">,
): Promise<DoctorReport> {
  const probes: DoctorProbes = {
    ...(await buildDefaultProbes()),
    ...options.probes,
  };

  let allGood = true;
  const checks: DoctorCheck[] = [];
  let loadedConfig: ProvConfig = {};

  // 1. Config validation
  try {
    const { loadConfig } = await import("./config-loader.js");
    const loaded = await loadConfig({ configPath: options.configPath, allowMissing: true });
    loadedConfig = loaded.config;
    checks.push({
      name: "config",
      status: "ok",
      message: loaded.configPath
        ? `Config is valid (${loaded.configPath})`
        : "No config file (using defaults)",
    });
  } catch (error) {
    checks.push({
      name: "config",
      status: "fail",
      message: `Config error: ${error instanceof Error ? error.message : String(error)}`,
      fix: "Run `spana validate-config` to see schema issues.",
    });
    allGood = false;
  }

  const targetPlatforms: Platform[] =
    options.platforms.length > 0
      ? options.platforms
      : (loadedConfig.platforms ?? ["web", "android", "ios", "electron", "electrobun"]);

  const warmDaemons = probes.listWarmDaemons();
  const warmByPort = new Map(warmDaemons.map((d) => [d.port, d]));

  // 2. Capacitor webview inspectability config check (when mobile targets included)
  if (targetPlatforms.includes("android") || targetPlatforms.includes("ios")) {
    const capContent = probes.readCapacitorConfig(probes.cwd);
    if (capContent !== null) {
      const hasAndroidDebug = /webContentsDebuggingEnabled\s*:\s*true/.test(capContent);
      checks.push({
        name: "capacitor-webview-config",
        status: hasAndroidDebug ? "ok" : "warn",
        message: hasAndroidDebug
          ? "Capacitor config enables webContentsDebuggingEnabled"
          : "Capacitor config detected without android.webContentsDebuggingEnabled: true",
        fix: hasAndroidDebug
          ? undefined
          : "Set `android: { webContentsDebuggingEnabled: true }` in capacitor.config.ts (or include spana-bridge in test builds).",
      });
    }
  }

  // 3. Per-platform checks
  for (const platform of targetPlatforms) {
    if (platform === "web") {
      const pw = await probes.checkPlaywright();
      if (pw.available) {
        checks.push({ name: "web", status: "ok", message: "Playwright available" });
      } else {
        checks.push({
          name: "web",
          status: "fail",
          message: "Playwright not installed",
          fix: "Install playwright-core and browsers (`npx playwright install`).",
        });
        allGood = false;
      }
    } else if (platform === "android") {
      const devices = probes.listAndroidDevices().filter((d) => d.state === "device");
      if (devices.length === 0) {
        checks.push({
          name: "android",
          status: "warn",
          message: "No Android devices or emulators connected",
          fix: "Connect a USB device with USB debugging enabled or boot an Android emulator.",
        });
      } else {
        checks.push({
          name: "android",
          status: "ok",
          message: `${devices.length} Android device(s) connected (${devices.map((d) => d.serial).join(", ")})`,
        });

        for (const dev of devices) {
          const wvVersion = probes.getAndroidWebViewVersion(dev.serial);
          checks.push({
            name: `android-webview-version (${dev.serial})`,
            status: wvVersion ? "ok" : "warn",
            message: wvVersion
              ? `Android System WebView / Chrome ${wvVersion} (direct CDP does not need a matching chromedriver)`
              : "Could not read WebView/Chrome version via adb dumpsys",
          });

          const sockets = probes.getAndroidWebViewSockets(dev.serial);
          checks.push({
            name: `android-webview-inspectable (${dev.serial})`,
            status: sockets.length > 0 ? "ok" : "warn",
            message:
              sockets.length > 0
                ? `${sockets.length} inspectable WebView socket(s): ${sockets.map((s) => s.socketName).join(", ")}`
                : "No webview_devtools_remote_* sockets currently open (launch app with setWebContentsDebuggingEnabled(true) or use spana-bridge)",
            fix:
              sockets.length > 0
                ? undefined
                : "Launch your debug build with WebView.setWebContentsDebuggingEnabled(true), or bundle spana-bridge.",
          });
        }
      }

      // Check UiAutomator2 port (8200)
      const ua2Port = 8200;
      const ua2Open = await probes.isPortOpen("127.0.0.1", ua2Port);
      const warmUa2 = warmByPort.get(ua2Port);
      if (ua2Open && warmUa2) {
        checks.push({
          name: "port-8200",
          status: "ok",
          message: `Warm UiAutomator2 daemon already listening on :${ua2Port} (${warmUa2.deviceId})`,
        });
      } else if (ua2Open) {
        checks.push({
          name: "port-8200",
          status: "warn",
          message: `Port ${ua2Port} is already in use by another process (Spana will allocate the next free port)`,
          fix: `Free port ${ua2Port} with \`lsof -i :${ua2Port}\` if you expect Spana to own it.`,
        });
      }
    } else if (platform === "ios") {
      const physical = probes.listIOSPhysicalDevices();
      const simulators = probes.listIOSSimulators().filter((s) => s.isAvailable);

      // USB vs network-only iPhone check (WDA + iproxy require USB)
      const wifiOnly = physical.filter(
        (d) => d.connectionType !== "USB" && d.connectionType !== "wired",
      );
      const usbDevices = physical.filter(
        (d) => d.connectionType === "USB" || d.connectionType === "wired",
      );

      if (wifiOnly.length > 0) {
        checks.push({
          name: "ios-usb-transport",
          status: "fail",
          message: `Network-only iOS device(s) detected: ${wifiOnly.map((d) => `${d.name} (${d.connectionType})`).join(", ")}. Direct WDA + iproxy requires a USB cable.`,
          fix: "Connect the iPhone/iPad over USB (not Wi-Fi only) so iproxy can tunnel port 8100.",
        });
        allGood = false;
      } else if (usbDevices.length > 0) {
        checks.push({
          name: "ios-usb-transport",
          status: "ok",
          message: `${usbDevices.length} USB-connected physical iOS device(s) ready`,
        });
      }

      if (usbDevices.length > 0 || simulators.length > 0) {
        checks.push({
          name: "ios",
          status: "ok",
          message: `${usbDevices.length} USB device(s), ${simulators.length} simulator(s) available`,
        });
      } else {
        checks.push({
          name: "ios",
          status: "warn",
          message: "No iOS simulators or USB devices available",
          fix: "Install Xcode Simulator runtimes or connect an iPhone via USB.",
        });
      }

      // iproxy check
      const hasIproxy = probes.commandExists("iproxy");
      checks.push({
        name: "ios-iproxy",
        status: hasIproxy ? "ok" : usbDevices.length > 0 ? "fail" : "warn",
        message: hasIproxy
          ? "iproxy available for physical iOS USB tunneling"
          : "iproxy not found (required for physical iPhones)",
        fix: hasIproxy ? undefined : "Install via Homebrew: `brew install libimobiledevice`",
      });
      if (!hasIproxy && usbDevices.length > 0) {
        allGood = false;
      }

      // WebKit Remote Inspector proxy check
      const hasWebKitProxy =
        probes.commandExists("ios_webkit_debug_proxy") || isWebKitDebugProxyInstalled();
      checks.push({
        name: "ios-webkit-inspector",
        status: hasWebKitProxy ? "ok" : "warn",
        message: hasWebKitProxy
          ? "ios_webkit_debug_proxy available for WKWebView DOM inspection (iOS 16.4+ isInspectable = true)"
          : "ios_webkit_debug_proxy not installed (WKWebView direct DOM falls back to spana-bridge)",
        fix: hasWebKitProxy
          ? undefined
          : "Install `brew install ios-webkit-debug-proxy` or include `spana-bridge` in test builds.",
      });

      // Check WDA port (8100)
      const wdaPort = 8100;
      const wdaOpen = await probes.isPortOpen("127.0.0.1", wdaPort);
      const warmWda = warmByPort.get(wdaPort);
      if (wdaOpen && warmWda) {
        checks.push({
          name: "port-8100",
          status: "ok",
          message: `Warm WDA daemon already listening on :${wdaPort} (${warmWda.deviceId})`,
        });
      } else if (wdaOpen) {
        checks.push({
          name: "port-8100",
          status: "warn",
          message: `Port ${wdaPort} is already in use by another process (not tracked as a Spana warm daemon)`,
          fix: `Inspect with \`lsof -i :${wdaPort}\` or enable \`execution.warmDaemons.enabled = true\`.`,
        });
      }
    } else if (platform === "electron") {
      const pw = await probes.checkPlaywright();
      const electronCfg = loadedConfig.apps?.electron;
      const hasConfig = Boolean(
        electronCfg?.entry ||
        electronCfg?.executablePath ||
        electronCfg?.cdpUrl ||
        electronCfg?.cdpPort,
      );
      checks.push({
        name: "electron",
        status: pw.hasElectron ? (hasConfig ? "ok" : "warn") : "fail",
        message: !pw.hasElectron
          ? "Playwright _electron API unavailable"
          : hasConfig
            ? `Electron ready (${electronCfg?.cdpUrl ?? electronCfg?.entry ?? electronCfg?.executablePath})`
            : "Playwright _electron available, but `apps.electron` is not configured in spana.config.ts",
        fix: !pw.hasElectron
          ? "Upgrade `playwright-core` to >= 1.49."
          : hasConfig
            ? undefined
            : "Add `apps.electron: { entry: './dist/main.js' }` or `{ cdpPort: 9222 }` to spana.config.ts.",
      });
      if (!pw.hasElectron) allGood = false;
    } else if (platform === "electrobun") {
      const ebCfg = loadedConfig.apps?.electrobun ?? {};
      const plan = resolveElectrobunLaunchPlan(ebCfg, probes.hostOs);
      const hasTarget = Boolean(
        ebCfg.executablePath ||
        ebCfg.appDir ||
        ebCfg.cdpUrl ||
        ebCfg.cdpPort ||
        ebCfg.bridge?.port ||
        loadedConfig.execution?.bridge?.enabled,
      );
      checks.push({
        name: "electrobun",
        status: hasTarget ? "ok" : "warn",
        message: hasTarget
          ? `Electrobun target configured (${plan.engine} on ${plan.hostOs}, channels: ${plan.preferredChannels.join(", ")})`
          : `Electrobun target (${plan.engine} on ${plan.hostOs}) not configured in spana.config.ts yet`,
        fix: hasTarget
          ? undefined
          : `Configure \`apps.electrobun\` (renderer: "native" | "cef") and include \`spana-bridge\` or CDP flags (${plan.notes}).`,
      });
    }
  }

  // 4. Bridge reachability check (if configured)
  const bridgeCfg = loadedConfig.execution?.bridge;
  if (bridgeCfg?.enabled || bridgeCfg?.port || bridgeCfg?.url) {
    const bridgeHost = bridgeCfg.host ?? "127.0.0.1";
    const bridgePort = bridgeCfg.port ?? 9333;
    const bridgeUrl = bridgeCfg.url ?? `http://${bridgeHost}:${bridgePort}/health`;
    const httpProbeUrl = bridgeUrl.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
    const reachable =
      (await probes.probeHttp(httpProbeUrl)) || (await probes.isPortOpen(bridgeHost, bridgePort));
    checks.push({
      name: "spana-bridge",
      status: reachable ? "ok" : "warn",
      message: reachable
        ? `spana-bridge endpoint reachable at ${bridgeHost}:${bridgePort}`
        : `spana-bridge not currently listening on ${bridgeHost}:${bridgePort} (will start automatically during \`spana test\`)`,
    });
  }

  const matrix = targetPlatforms.map((p) =>
    resolveTargetDescriptor(p, loadedConfig, probes.hostOs),
  );
  return { allGood, checks, matrix, warmDaemons };
}

export async function runDoctorCommand(options: DoctorOptions): Promise<boolean> {
  const report = await collectDoctorReport(options);

  if (options.json) {
    const { createMachineSuccess, printMachinePayload } = await import("../machine.js");
    printMachinePayload(
      createMachineSuccess("doctor", {
        allGood: report.allGood,
        checks: report.checks,
        matrix: report.matrix,
        warmDaemons: report.warmDaemons,
      }),
      options.pretty,
    );
  } else {
    for (const check of report.checks) {
      const icon = check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗";
      console.log(`  ${icon} ${check.name}: ${check.message}`);
      if (check.fix) {
        console.log(`      Fix: ${check.fix}`);
      }
    }
    console.log("\nTarget × Channel Matrix:\n");
    console.log(
      formatTargetMatrixTable(
        report.matrix.map((m) => m.platform),
        undefined,
        options.probes?.hostOs,
      ),
    );
    console.log(report.allGood ? "\nEnvironment ready." : "\nSome checks need attention.");
  }

  return report.allGood;
}
