import type { Platform } from "../schemas/selector.js";

const args = process.argv.slice(2);
const command = args[0];

if (command === "test") {
  const platforms: Platform[] = [];
  let tags: string[] | undefined;
  let grep: string | undefined;
  let reporter: string | undefined;
  let configPath: string | undefined;
  let flowPath: string | undefined;
  let retries: number | undefined;
  let device: string | undefined;
  let driver: "local" | "appium" | undefined;
  let appiumUrl: string | undefined;
  let capsPath: string | undefined;
  let capsJson: string | undefined;
  let noProviderReporting = false;
  let validateConfigOnly = false;
  let shard: { current: number; total: number } | undefined;
  let bail: number | undefined;
  let debugOnFailure = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--platform" && args[i + 1]) {
      platforms.push(...(args[++i]!.split(",") as Platform[]));
    } else if (arg === "--tag" && args[i + 1]) {
      tags = args[++i]!.split(",");
    } else if (arg === "--grep" && args[i + 1]) {
      grep = args[++i];
    } else if (arg === "--reporter" && args[i + 1]) {
      reporter = args[++i]!;
    } else if (arg === "--config" && args[i + 1]) {
      configPath = args[++i];
    } else if (arg === "--retries" && args[i + 1]) {
      retries = parseInt(args[++i]!, 10);
    } else if (arg === "--device" && args[i + 1]) {
      device = args[++i];
    } else if (arg === "--driver" && args[i + 1]) {
      driver = args[++i] as "local" | "appium";
    } else if (arg === "--appium-url" && args[i + 1]) {
      appiumUrl = args[++i];
    } else if (arg === "--caps" && args[i + 1]) {
      capsPath = args[++i];
    } else if (arg === "--caps-json" && args[i + 1]) {
      capsJson = args[++i];
    } else if (arg === "--no-provider-reporting") {
      noProviderReporting = true;
    } else if (arg === "--validate-config") {
      validateConfigOnly = true;
    } else if (arg === "--shard" && args[i + 1]) {
      const [currentText, totalText] = args[++i]!.split("/");
      const current = Number(currentText);
      const total = Number(totalText);
      if (
        !Number.isInteger(current) ||
        !Number.isInteger(total) ||
        current < 1 ||
        total < 1 ||
        current > total
      ) {
        console.log(
          "Invalid --shard format. Use --shard <current>/<total> with 1 <= current <= total.",
        );
        process.exit(1);
      }
      shard = { current, total };
    } else if (arg === "--bail" && args[i + 1]) {
      bail = Number.parseInt(args[++i]!, 10);
      if (!Number.isInteger(bail) || bail < 1) {
        console.log("Invalid --bail value. Use --bail <n> with n >= 1.");
        process.exit(1);
      }
    } else if (arg === "--debug-on-failure") {
      debugOnFailure = true;
    } else if (!arg.startsWith("--")) {
      flowPath = arg;
    }
  }

  const { runTestCommand } = await import("./test-command.js");
  const success = await runTestCommand({
    platforms,
    tags,
    grep,
    reporter,
    configPath,
    flowPath,
    retries,
    device,
    driver,
    appiumUrl,
    capsPath,
    capsJson,
    noProviderReporting,
    validateConfigOnly,
    shard,
    bail,
    debugOnFailure,
  });
  process.exit(success ? 0 : 1);
} else if (command === "hierarchy" || command === "selectors") {
  let platform: Platform = "web";
  let pretty = false;
  let configPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) platform = args[++i] as Platform;
    if (args[i] === "--pretty") pretty = true;
    if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  }
  // Load config for baseUrl/packageName/bundleId
  let config: Record<string, any> = {};
  try {
    const { loadConfig } = await import("./config-loader.js");
    config = (await loadConfig({ configPath, allowMissing: true })).config as Record<string, any>;
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const { connect } = await import("../agent/session.js");
  const session = await connect({
    platform,
    baseUrl: config.apps?.web?.url,
    packageName: config.apps?.android?.packageName,
    bundleId: config.apps?.ios?.bundleId,
  });
  if (command === "hierarchy") {
    const root = await session.hierarchy();
    console.log(pretty ? JSON.stringify(root, null, 2) : JSON.stringify(root));
  } else {
    const elements = await session.selectors();
    console.log(JSON.stringify(elements, null, 2));
  }
  await session.disconnect();
} else if (command === "validate") {
  const path = args[1] ?? "./flows";
  const { validateProject } = await import("../core/validator.js");
  const errors = await validateProject(path);
  if (errors.length === 0) {
    const { discoverFlows } = await import("../core/runner.js");
    const paths = await discoverFlows(path);
    console.log(`✓ ${paths.length} flow(s) valid`);
  } else {
    for (const e of errors) console.log(`✗ ${e.file}: ${e.error}`);
    process.exit(1);
  }
} else if (command === "validate-config") {
  let configPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config" && args[i + 1]) {
      configPath = args[++i];
    } else if (!arg.startsWith("--")) {
      configPath = arg;
    }
  }
  const { loadConfig } = await import("./config-loader.js");
  try {
    const result = await loadConfig({ configPath });
    console.log(`✓ Config valid (${result.configPath})`);
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
} else if (command === "studio") {
  let port = 4400;
  let open = true;
  let configPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--port" && args[i + 1]) port = Number(args[++i]);
    if (args[i] === "--no-open") open = false;
    if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  }
  let config: Record<string, any> = {};
  try {
    const { loadConfig } = await import("./config-loader.js");
    config = (await loadConfig({ configPath, allowMissing: true })).config as Record<string, any>;
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const { runStudioCommand } = await import("./studio-command.js");
  await runStudioCommand({ port, open, config: config as any });
} else if (command === "init") {
  const force = args.includes("--force");
  const { runInitCommand } = await import("./init-command.js");
  await runInitCommand({ force });
} else if (command === "devices") {
  const { discoverDevices } = await import("../device/discover.js");
  const devices = discoverDevices(["web", "android", "ios"]);
  if (devices.length === 0) {
    console.log("No devices found.");
  } else {
    for (const d of devices) {
      console.log(`  ${d.platform.padEnd(8)} ${d.name.padEnd(30)} ${d.type.padEnd(10)} ${d.state}`);
    }
  }
} else if (command === "version" || args.includes("--version") || args.includes("-v")) {
  console.log("spana v0.0.1");
} else {
  console.log("spana — TypeScript-native E2E testing for React Native + Web");
  console.log("");
  console.log("Commands:");
  console.log("  spana test [path]              Run test flows");
  console.log("  spana hierarchy --platform <p> Dump element hierarchy as JSON");
  console.log("  spana selectors --platform <p> List actionable elements with suggested selectors");
  console.log("  spana validate [path]          Validate flow files without device connection");
  console.log("  spana validate-config [path]   Validate spana.config.ts without running flows");
  console.log("  spana studio                   Launch Spana Studio UI");
  console.log("  spana init                     Initialize a new spana project");
  console.log("  spana devices                  List connected devices across platforms");
  console.log("  spana version                  Show version");
  console.log("");
  console.log("Options:");
  console.log("  --platform web,android,ios  Platforms to test (default: spana.config.ts or web)");
  console.log("  --tag smoke,auth           Filter by tags");
  console.log("  --grep login               Filter by name pattern");
  console.log(
    "  --reporter console|json|junit Reporter format (default: spana.config.ts or console)",
  );
  console.log("  --retries <n>              Retry failed flows n times (flake detection)");
  console.log("  --shard <current>/<total> Distribute flows across CI jobs");
  console.log("  --bail <n>                 Abort after N failures");
  console.log("  --debug-on-failure         Open an interactive REPL on the first failed flow");
  console.log("  --device <id>              Target a specific device by ID");
  console.log("  --validate-config          Validate config and exit");
  console.log("  --config path              Config file path");
  console.log("  --pretty                   Pretty-print JSON output (hierarchy command)");
  console.log("  --port <number>            Studio port (default: 4400)");
  console.log("  --no-open                  Don't open browser (studio command)");
  console.log("  --force                    Overwrite existing files (init command)");
}
