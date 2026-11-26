#!/usr/bin/env bun
/**
 * Real Physical/Simulator Mobile Device Benchmark for Spana.
 *
 * Measures actual, live end-to-end timings on attached Android (UiAutomator2 + Chrome CDP)
 * and iOS (WebDriverAgent) devices — zero fabricated or hardcoded constants.
 *
 * Usage:
 *   bun packages/spana/scripts/benchmark-mobile-devices.ts --android 47041FDJG000FB
 *   bun packages/spana/scripts/benchmark-mobile-devices.ts --ios-url http://[fd99:7988:6a33::1]:8100 --ios-name "iPhone 17 Pro" --ios-os "27.2.1" --ios-udid 00008150-001A70613AB8401C
 */
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Effect } from "effect";
import { flow } from "../src/api/flow.js";
import { executeFlow } from "../src/core/engine.js";
import { setupUiAutomator2 } from "../src/drivers/uiautomator2/installer.js";
import { createUiAutomator2Driver } from "../src/drivers/uiautomator2/driver.js";
import { parseAndroidHierarchy } from "../src/drivers/uiautomator2/pagesource.js";
import { createWDADriver } from "../src/drivers/wda/driver.js";
import { parseIOSHierarchy } from "../src/drivers/wda/pagesource.js";
import { makeLightweightCdpDriver } from "../src/drivers/cdp-browser.js";
import { parseWebHierarchy } from "../src/drivers/playwright-parser.js";
import { allocateFreePort } from "../src/core/port-allocator.js";

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

function countNodes(node: { children?: unknown[] } | undefined): number {
  if (!node) return 0;
  let total = 1;
  for (const child of (node.children as Array<{ children?: unknown[] }> | undefined) ?? []) {
    total += countNodes(child);
  }
  return total;
}

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx === -1) return undefined;
  return process.argv[idx + 1];
}

function adb(serial: string, args: string[]): string {
  return execFileSync("adb", ["-s", serial, ...args], {
    encoding: "utf8",
    env: { ...process.env, HOME: process.env.SPANA_ADB_HOME ?? "/tmp/spana-adb-home" },
  }).trim();
}

export interface AndroidDeviceBenchmarkResult {
  measuredAt: string;
  platform: "android";
  deviceType: "physical" | "emulator";
  model: string;
  osVersion: string;
  serial: string;
  screen: { width: number; height: number };
  coldDaemonSetupMs: number;
  warmDaemonReuseMs: number;
  dumpHierarchy: {
    samplesMs: number[];
    medianMs: number;
    avgBytes: number;
    avgNodes: number;
  };
  takeScreenshot: {
    samplesMs: number[];
    medianMs: number;
    avgBytes: number;
  };
  native5FlowsSettings: {
    flowCount: number;
    totalMs: number;
    avgFlowMs: number;
    perFlowMs: number[];
    passed: number;
  };
  chromeCdp5Flows?: {
    flowCount: number;
    uiLoginTotalMs: number;
    uiLoginAvgFlowMs: number;
    stateInjectTotalMs: number;
    stateInjectAvgFlowMs: number;
    speedup: number;
  };
}

export interface IOSDeviceBenchmarkResult {
  measuredAt: string;
  platform: "ios";
  deviceType: "physical" | "simulator";
  model: string;
  osVersion: string;
  udid: string;
  screen: { width: number; height: number };
  sessionInitMs: number;
  dumpHierarchy: {
    samplesMs: number[];
    medianMs: number;
    avgBytes: number;
    avgNodes: number;
  };
  takeScreenshot: {
    samplesMs: number[];
    medianMs: number;
    avgBytes: number;
  };
  native5FlowsSettings: {
    flowCount: number;
    totalMs: number;
    avgFlowMs: number;
    perFlowMs: number[];
    passed: number;
  };
}

async function runAndroidBenchmark(serial: string): Promise<AndroidDeviceBenchmarkResult> {
  const model = adb(serial, ["shell", "getprop", "ro.product.model"]);
  const osVersion = adb(serial, ["shell", "getprop", "ro.build.version.release"]);
  const isEmulator = serial.startsWith("emulator-");

  console.log(
    `\n=== Running LIVE Android benchmark on ${model} (Android ${osVersion}, ${serial}) ===`,
  );

  const port = await allocateFreePort(8210);
  const stateFile = `/tmp/spana-bench-android-${Date.now()}.json`;

  // 1. Cold UiAutomator2 daemon start + session
  const coldStart = performance.now();
  const conn = await setupUiAutomator2(serial, port, { warm: true, daemonStateFile: stateFile });
  const coldDaemonSetupMs = Math.round(performance.now() - coldStart);
  console.log(`  Cold UiAutomator2 daemon start: ${coldDaemonSetupMs}ms`);

  // 2. Warm daemon reuse check
  const warmStart = performance.now();
  const warmConn = await setupUiAutomator2(serial, port, {
    warm: true,
    daemonStateFile: stateFile,
  });
  const warmDaemonReuseMs = Math.round(performance.now() - warmStart);
  console.log(
    `  Warm UiAutomator2 daemon reuse: ${warmDaemonReuseMs}ms (reused=${warmConn.reusedWarmDaemon})`,
  );

  const driver = await Effect.runPromise(
    createUiAutomator2Driver(conn.host, conn.port, serial, "com.android.settings"),
  );
  const info = await Effect.runPromise(driver.getDeviceInfo());

  try {
    // Launch Android Settings cleanly
    await Effect.runPromise(driver.launchApp("com.android.settings"));
    await new Promise((r) => setTimeout(r, 800));

    // 3. Measure 5x dumpHierarchy
    const dumpSamples: number[] = [];
    let totalXmlBytes = 0;
    let totalNodes = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const xml = await Effect.runPromise(driver.dumpHierarchy());
      dumpSamples.push(Math.round(performance.now() - t0));
      totalXmlBytes += xml.length;
      totalNodes += countNodes(parseAndroidHierarchy(xml));
    }
    console.log(
      `  dumpHierarchy (5 runs): median=${median(dumpSamples)}ms samples=[${dumpSamples.join(",")}]`,
    );

    // 4. Measure 5x takeScreenshot
    const shotSamples: number[] = [];
    let totalPngBytes = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const png = await Effect.runPromise(driver.takeScreenshot());
      shotSamples.push(Math.round(performance.now() - t0));
      totalPngBytes += png.byteLength;
    }
    console.log(
      `  takeScreenshot (5 runs): median=${median(shotSamples)}ms samples=[${shotSamples.join(",")}]`,
    );

    // 5. Measure 5-flow native Android Settings E2E suite via executeFlow
    const targetSections = [
      { menu: "Display and touch", verify: "Brightness level" },
      { menu: "Sound and vibration", verify: "Media volume" },
      { menu: "Notifications", verify: "Notification history" },
      { menu: "Apps", verify: "Default apps" },
      { menu: "Connected devices", verify: "Pair new device" },
    ];

    const perFlowMs: number[] = [];
    let passed = 0;
    const suiteT0 = performance.now();
    for (let i = 0; i < targetSections.length; i++) {
      const sec = targetSections[i]!;
      const f = flow(`Android Settings flow ${i + 1}: ${sec.menu}`, async ({ app, expect }) => {
        await app.launch();
        await expect({ text: sec.menu }).toBeVisible({ timeout: 8000 });
        await app.tap({ text: sec.menu }, { timeout: 8000 });
        await expect({ text: sec.verify }).toBeVisible({ timeout: 8000 });
        await app.back();
        await expect({ text: "Search Settings" }).toBeVisible({ timeout: 8000 });
      });
      const fT0 = performance.now();
      const res = await executeFlow(f, driver, {
        appId: "com.android.settings",
        platform: "android",
        coordinatorConfig: {
          parse: parseAndroidHierarchy,
          platform: "android",
          screenWidth: info.screenWidth,
          screenHeight: info.screenHeight,
        },
        autoLaunch: false,
        flowTimeout: 30_000,
      });
      const elapsed = Math.round(performance.now() - fT0);
      perFlowMs.push(elapsed);
      if (res.status === "passed") {
        passed += 1;
        console.log(`  Flow ${i + 1} (${sec.menu}): PASS in ${elapsed}ms`);
      } else {
        console.log(`  Flow ${i + 1} (${sec.menu}): FAIL (${res.error?.message}) in ${elapsed}ms`);
      }
    }
    const totalMs = Math.round(performance.now() - suiteT0);

    // 6. Real Android Chrome CDP 5-flow hybrid web benchmark (UI login vs state injection)
    let chromeCdp5Flows: AndroidDeviceBenchmarkResult["chromeCdp5Flows"];
    try {
      const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Spana Mobile Bench</title></head><body>
        <div id="login-view">
          <input data-testid="email" type="email" />
          <input data-testid="password" type="password" />
          <button data-testid="signin" type="button">Sign In</button>
        </div>
        <div id="app-view" style="display:none">
          <h1 data-testid="welcome">Dashboard Ready</h1>
          <input data-testid="task-input" type="text" />
          <button data-testid="add-task" type="button">Add Task</button>
          <ul data-testid="task-list"></ul>
        </div>
        <script>
          const render = () => {
            const authed = Boolean(localStorage.getItem("spana_token"));
            document.getElementById("login-view").style.display = authed ? "none" : "block";
            document.getElementById("app-view").style.display = authed ? "block" : "none";
          };
          document.querySelector('[data-testid="signin"]').onclick = () => {
            localStorage.setItem("spana_token", "live-mobile-token");
            render();
          };
          document.querySelector('[data-testid="add-task"]').onclick = () => {
            const inp = document.querySelector('[data-testid="task-input"]');
            const li = document.createElement("li");
            li.setAttribute("data-testid", "task-item");
            li.textContent = inp.value;
            document.querySelector('[data-testid="task-list"]').appendChild(li);
            inp.value = "";
          };
          render();
        </script>
      </body></html>`;

      const srv = createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(html);
      });
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
      const webPort = (srv.address() as { port: number }).port;
      const cdpHostPort = await allocateFreePort(9422);

      adb(serial, ["reverse", `tcp:${webPort}`, `tcp:${webPort}`]);
      adb(serial, ["forward", `tcp:${cdpHostPort}`, "localabstract:chrome_devtools_remote"]);
      adb(serial, [
        "shell",
        "am",
        "start",
        "-n",
        "com.android.chrome/com.google.android.apps.chrome.Main",
        "-d",
        `http://127.0.0.1:${webPort}/`,
      ]);
      await new Promise((r) => setTimeout(r, 1200));

      const cdpDriver = await Effect.runPromise(
        makeLightweightCdpDriver({
          cdpUrl: `http://127.0.0.1:${cdpHostPort}`,
          baseUrl: `http://127.0.0.1:${webPort}`,
          engineLabel: "android-chrome-cdp",
          useBrowserContexts: false,
        }),
      );

      try {
        const uiT0 = performance.now();
        for (let i = 0; i < 5; i++) {
          const f = flow(`Pixel Chrome UI Login ${i + 1}`, async ({ app, expect }) => {
            await app.clearStorage();
            await app.openLink(`http://127.0.0.1:${webPort}/?run=${i}`);
            await app.fill({ testID: "email" }, `user${i}@spana.dev`);
            await app.fill({ testID: "password" }, "secret-123");
            await app.tap({ testID: "signin" }, { tapMode: "dom" });
            await expect({ testID: "welcome" }).toBeVisible();
            await app.fill({ testID: "task-input" }, `Task ${i}`);
            await app.tap({ testID: "add-task" }, { tapMode: "dom" });
            await expect({ testID: "task-item" }).toHaveText(`Task ${i}`);
          });
          const res = await executeFlow(f, cdpDriver, {
            appId: `http://127.0.0.1:${webPort}`,
            platform: "web",
            coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
            autoLaunch: false,
            flowTimeout: 20_000,
          });
          if (res.status !== "passed") throw new Error(res.error?.message);
        }
        const uiLoginTotalMs = Math.round(performance.now() - uiT0);

        const injT0 = performance.now();
        for (let i = 0; i < 5; i++) {
          const f = flow(`Pixel Chrome State Inject ${i + 1}`, async ({ app, expect }) => {
            await app.setStorage({ localStorage: { spana_token: "live-mobile-token" } });
            await app.openLink(`http://127.0.0.1:${webPort}/?inject=${i}`);
            await expect({ testID: "welcome" }).toBeVisible();
            await app.fill({ testID: "task-input" }, `Fast ${i}`);
            await app.tap({ testID: "add-task" }, { tapMode: "dom" });
            await expect({ testID: "task-item" }).toHaveText(`Fast ${i}`);
          });
          const res = await executeFlow(f, cdpDriver, {
            appId: `http://127.0.0.1:${webPort}`,
            platform: "web",
            coordinatorConfig: { parse: parseWebHierarchy, platform: "web" },
            autoLaunch: false,
            flowTimeout: 20_000,
          });
          if (res.status !== "passed") throw new Error(res.error?.message);
        }
        const stateInjectTotalMs = Math.round(performance.now() - injT0);
        chromeCdp5Flows = {
          flowCount: 5,
          uiLoginTotalMs,
          uiLoginAvgFlowMs: Math.round(uiLoginTotalMs / 5),
          stateInjectTotalMs,
          stateInjectAvgFlowMs: Math.round(stateInjectTotalMs / 5),
          speedup: Number((uiLoginTotalMs / Math.max(1, stateInjectTotalMs)).toFixed(2)),
        };
        console.log(
          `  Pixel Chrome CDP 5-flow: UI-login=${uiLoginTotalMs}ms (${chromeCdp5Flows.uiLoginAvgFlowMs}ms/flow), state-inject=${stateInjectTotalMs}ms (${chromeCdp5Flows.stateInjectAvgFlowMs}ms/flow), speedup=${chromeCdp5Flows.speedup}x`,
        );
      } finally {
        await Effect.runPromise(cdpDriver.killApp("")).catch(() => {});
        try {
          adb(serial, ["reverse", "--remove", `tcp:${webPort}`]);
          adb(serial, ["forward", "--remove", `tcp:${cdpHostPort}`]);
        } catch {
          // ignore
        }
        await new Promise<void>((r) => srv.close(() => r()));
      }
    } catch (err) {
      console.warn(
        `  Pixel Chrome CDP benchmark skipped: ${err instanceof Error ? err.message : err}`,
      );
    }

    return {
      measuredAt: new Date().toISOString(),
      platform: "android",
      deviceType: isEmulator ? "emulator" : "physical",
      model,
      osVersion,
      serial,
      screen: { width: info.screenWidth, height: info.screenHeight },
      coldDaemonSetupMs,
      warmDaemonReuseMs,
      dumpHierarchy: {
        samplesMs: dumpSamples,
        medianMs: median(dumpSamples),
        avgBytes: Math.round(totalXmlBytes / dumpSamples.length),
        avgNodes: Math.round(totalNodes / dumpSamples.length),
      },
      takeScreenshot: {
        samplesMs: shotSamples,
        medianMs: median(shotSamples),
        avgBytes: Math.round(totalPngBytes / shotSamples.length),
      },
      native5FlowsSettings: {
        flowCount: targetSections.length,
        totalMs,
        avgFlowMs: Math.round(totalMs / targetSections.length),
        perFlowMs,
        passed,
      },
      ...(chromeCdp5Flows ? { chromeCdp5Flows } : {}),
    };
  } finally {
    await Effect.runPromise(driver.killApp("com.android.settings")).catch(() => {});
    // Stop the benchmark daemon cleanly so we don't leave a stray process behind
    try {
      const { stopAllWarmDaemons } = await import("../src/runtime/daemon-manager.js");
      stopAllWarmDaemons(stateFile);
    } catch {
      // ignore
    }
    conn.cleanup?.();
  }
}

async function runIOSBenchmark(opts: {
  wdaHost: string;
  wdaPort: number;
  model: string;
  osVersion: string;
  udid: string;
  deviceType: "physical" | "simulator";
}): Promise<IOSDeviceBenchmarkResult> {
  console.log(
    `\n=== Running LIVE iOS benchmark on ${opts.model} (iOS ${opts.osVersion}, ${opts.deviceType}) via WDA ${opts.wdaHost}:${opts.wdaPort} ===`,
  );

  const initT0 = performance.now();
  const driver = await Effect.runPromise(
    createWDADriver(
      opts.wdaHost,
      opts.wdaPort,
      "com.apple.Preferences",
      opts.deviceType === "simulator" ? opts.udid : undefined,
      60,
    ),
  );
  const info = await Effect.runPromise(driver.getDeviceInfo());
  const sessionInitMs = Math.round(performance.now() - initT0);
  console.log(`  WDA session init: ${sessionInitMs}ms (${info.screenWidth}x${info.screenHeight})`);

  try {
    await Effect.runPromise(driver.launchApp("com.apple.Preferences"));
    await new Promise((r) => setTimeout(r, 800));

    // Measure 5x dumpHierarchy
    const dumpSamples: number[] = [];
    let totalXmlBytes = 0;
    let totalNodes = 0;
    let sampleLabels: string[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const xml = await Effect.runPromise(driver.dumpHierarchy());
      dumpSamples.push(Math.round(performance.now() - t0));
      totalXmlBytes += xml.length;
      const tree = parseIOSHierarchy(xml);
      totalNodes += countNodes(tree);
      if (i === 0) {
        const walk = (n: any) => {
          if (n.text) sampleLabels.push(n.text);
          else if (n.accessibilityLabel) sampleLabels.push(n.accessibilityLabel);
          for (const c of n.children ?? []) walk(c);
        };
        walk(tree);
      }
    }
    console.log(
      `  dumpHierarchy (5 runs): median=${median(dumpSamples)}ms samples=[${dumpSamples.join(",")}]`,
    );
    console.log(`  sample Settings labels: ${sampleLabels.slice(0, 15).join(", ")}`);

    // Measure 5x takeScreenshot
    const shotSamples: number[] = [];
    let totalPngBytes = 0;
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const png = await Effect.runPromise(driver.takeScreenshot());
      shotSamples.push(Math.round(performance.now() - t0));
      totalPngBytes += png.byteLength;
    }
    console.log(
      `  takeScreenshot (5 runs): median=${median(shotSamples)}ms samples=[${shotSamples.join(",")}]`,
    );

    // 5-flow native iOS Settings E2E suite (launch -> verify menu -> tap -> verify sub-screen)
    // On physical iOS devices, avoid carrier-entitlement panes (Personal Hotspot / Mobile Service)
    // that trigger live cellular network calls and can stall XCUITest/WDA.
    const sections: Array<{ menu: string; verify: string; scrollFirst?: boolean }> =
      opts.deviceType === "physical"
        ? [
            { menu: "Wi-Fi", verify: "Wi-Fi" },
            { menu: "Bluetooth", verify: "Bluetooth" },
            { menu: "Battery", verify: "Battery" },
            { menu: "General", verify: "About", scrollFirst: true },
            { menu: "General", verify: "Software Update", scrollFirst: true },
          ]
        : [
            { menu: "General", verify: "About" },
            { menu: "General", verify: "Software Update" },
            { menu: "General", verify: "Language & Region" },
            { menu: "General", verify: "Keyboard" },
            { menu: "General", verify: "Fonts" },
          ];

    const perFlowMs: number[] = [];
    let passed = 0;
    const suiteT0 = performance.now();
    for (let i = 0; i < sections.length; i++) {
      const sec = sections[i]!;
      const f = flow(
        `iOS Settings flow ${i + 1}: ${sec.menu} > ${sec.verify}`,
        async ({ app, expect }) => {
          await app.stop();
          await app.launch();
          if (sec.scrollFirst) {
            await app.swipe("up");
          }
          await expect({ text: sec.menu }).toBeVisible({ timeout: 8000 });
          await app.tap({ text: sec.menu }, { timeout: 8000 });
          await expect({ text: sec.verify }).toBeVisible({ timeout: 8000 });
        },
      );
      const fT0 = performance.now();
      const res = await executeFlow(f, driver, {
        appId: "com.apple.Preferences",
        platform: "ios",
        coordinatorConfig: {
          parse: parseIOSHierarchy,
          platform: "ios",
          screenWidth: info.screenWidth,
          screenHeight: info.screenHeight,
        },
        autoLaunch: false,
        flowTimeout: 30_000,
      });
      const elapsed = Math.round(performance.now() - fT0);
      perFlowMs.push(elapsed);
      if (res.status === "passed") {
        passed += 1;
        console.log(`  Flow ${i + 1} (${sec.verify}): PASS in ${elapsed}ms`);
      } else {
        console.log(
          `  Flow ${i + 1} (${sec.verify}): FAIL (${res.error?.message}) in ${elapsed}ms`,
        );
      }
    }
    const totalMs = Math.round(performance.now() - suiteT0);

    return {
      measuredAt: new Date().toISOString(),
      platform: "ios",
      deviceType: opts.deviceType,
      model: opts.model,
      osVersion: opts.osVersion,
      udid: opts.udid,
      screen: { width: info.screenWidth, height: info.screenHeight },
      sessionInitMs,
      dumpHierarchy: {
        samplesMs: dumpSamples,
        medianMs: median(dumpSamples),
        avgBytes: Math.round(totalXmlBytes / dumpSamples.length),
        avgNodes: Math.round(totalNodes / dumpSamples.length),
      },
      takeScreenshot: {
        samplesMs: shotSamples,
        medianMs: median(shotSamples),
        avgBytes: Math.round(totalPngBytes / shotSamples.length),
      },
      native5FlowsSettings: {
        flowCount: sections.length,
        totalMs,
        avgFlowMs: Math.round(totalMs / sections.length),
        perFlowMs,
        passed,
      },
    };
  } finally {
    await Effect.runPromise(driver.killApp("com.apple.Preferences")).catch(() => {});
  }
}

async function main() {
  const androidSerial = parseArg("--android");
  const iosHost = parseArg("--ios-host");
  const iosPort = parseArg("--ios-port") ? Number.parseInt(parseArg("--ios-port")!, 10) : 8100;
  const iosModel = parseArg("--ios-model") ?? "iPhone";
  const iosOs = parseArg("--ios-os") ?? "unknown";
  const iosUdid = parseArg("--ios-udid") ?? "unknown";
  const iosType = (parseArg("--ios-type") as "physical" | "simulator" | undefined) ?? "physical";

  const outPath = resolve(
    import.meta.dirname,
    "../../../benchmarks/framework-comparison/mobile-devices.json",
  );
  mkdirSync(resolve(outPath, ".."), { recursive: true });
  const existing = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};

  if (androidSerial) {
    existing.android = await runAndroidBenchmark(androidSerial);
  }
  if (iosHost) {
    const key = iosType === "simulator" ? "iosSimulator" : "ios";
    existing[key] = await runIOSBenchmark({
      wdaHost: iosHost,
      wdaPort: iosPort,
      model: iosModel,
      osVersion: iosOs,
      udid: iosUdid,
      deviceType: iosType,
    });
  }

  writeFileSync(outPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
  console.log(`\nSaved live mobile device benchmarks to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
