import type { Platform } from "../schemas/selector.js";
import {
  buildDocsUrl,
  createMachineFailure,
  createMachineSuccess,
  printMachinePayload,
} from "../machine.js";
import { configCommandError, normalizeErrorMessage } from "./command-errors.js";
import { isFlowStubPreset, isInitPreset } from "./scaffolds.js";

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
  let appiumAutoStart = false;
  let capsPath: string | undefined;
  let capsJson: string | undefined;
  let noProviderReporting = false;
  let validateConfigOnly = false;
  let shard: { current: number; total: number } | undefined;
  let bail: number | undefined;
  let debugOnFailure = false;
  let quiet = false;
  let parallel = false;
  let workers: number | undefined;
  let devices: string[] | undefined;
  let verbose = false;
  let lastFailed = false;
  let changed = false;
  let watch = false;
  let updateBaselines = false;

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
    } else if (arg === "--appium-auto-start") {
      appiumAutoStart = true;
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
    } else if (arg === "--quiet" || arg === "-q") {
      quiet = true;
    } else if (arg === "--parallel") {
      parallel = true;
    } else if (arg === "--workers" && args[i + 1]) {
      workers = parseInt(args[++i]!, 10);
    } else if (arg === "--devices" && args[i + 1]) {
      devices = args[++i]!.split(",");
    } else if (arg === "--verbose") {
      verbose = true;
    } else if (arg === "--last-failed") {
      lastFailed = true;
    } else if (arg === "--changed") {
      changed = true;
    } else if (arg === "--watch") {
      watch = true;
    } else if (arg === "--update-baselines") {
      updateBaselines = true;
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
    appiumAutoStart,
    capsPath,
    capsJson,
    noProviderReporting,
    validateConfigOnly,
    shard,
    bail,
    debugOnFailure,
    quiet,
    parallel,
    workers,
    devices,
    verbose,
    lastFailed,
    changed,
    watch,
    updateBaselines,
  });
  process.exit(success ? 0 : 1);
} else if (command === "hierarchy" || command === "selectors") {
  let platform: Platform = "web";
  let pretty = false;
  let jsonMode = false;
  let configPath: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) platform = args[++i] as Platform;
    if (args[i] === "--pretty") pretty = true;
    if (args[i] === "--json") jsonMode = true;
    if (args[i] === "--config" && args[i + 1]) configPath = args[++i];
  }
  // Load config for baseUrl/packageName/bundleId
  let config: Record<string, any> = {};
  try {
    const { loadConfig } = await import("./config-loader.js");
    config = (await loadConfig({ configPath, allowMissing: true })).config as Record<string, any>;
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (jsonMode) {
      printMachinePayload(createMachineFailure(command, configCommandError(message)), pretty);
    } else {
      console.log(message);
    }
    process.exit(1);
  }
  const { connect } = await import("../agent/session.js");
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  try {
    session = await connect({
      platform,
      baseUrl: config.apps?.web?.url,
      browser: config.execution?.web?.browser,
      headless: config.execution?.web?.headless,
      storageState: config.execution?.web?.storageState,
      verboseLogging: config.execution?.web?.verboseLogging,
      packageName: config.apps?.android?.packageName,
      bundleId: config.apps?.ios?.bundleId,
    });
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (jsonMode) {
      printMachinePayload(
        createMachineFailure(command, {
          errorCode: "SESSION_CONNECT_FAILED",
          message,
          suggestedFix: `Make sure the ${platform} target is running and Spana can connect to it before retrying.`,
          docsUrl: buildDocsUrl("/cli/agent-commands"),
        }),
        pretty,
      );
    } else {
      console.log(message);
    }
    process.exit(1);
  }

  try {
    if (command === "hierarchy") {
      const root = await session.hierarchy();
      await session.disconnect();
      if (jsonMode) {
        printMachinePayload(createMachineSuccess(command, { platform, root }), pretty);
      } else {
        console.log(pretty ? JSON.stringify(root, null, 2) : JSON.stringify(root));
      }
    } else {
      const elements = await session.selectors();
      await session.disconnect();
      if (jsonMode) {
        printMachinePayload(createMachineSuccess(command, { platform, elements }), pretty);
      } else {
        console.log(JSON.stringify(elements, null, 2));
      }
    }
  } catch (error) {
    await session.disconnect().catch(() => undefined);
    const message = normalizeErrorMessage(error);
    if (jsonMode) {
      printMachinePayload(
        createMachineFailure(command, {
          errorCode: "SESSION_QUERY_FAILED",
          message,
          suggestedFix: `Make sure the app is on the expected ${platform} screen before rerunning \`spana ${command}\`.`,
          docsUrl: buildDocsUrl("/cli/agent-commands"),
        }),
        pretty,
      );
    } else {
      console.log(message);
    }
    process.exit(1);
  }
} else if (command === "validate") {
  let path = "./flows";
  let jsonMode = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json") {
      jsonMode = true;
    } else if (!arg.startsWith("--")) {
      path = arg;
    }
  }

  const { discoverFlows } = await import("../core/runner.js");
  const { validateProject, isValidationIssue, summarizeValidationResults } =
    await import("../core/validator.js");
  const results = await validateProject(path);
  const { errorCount, warningCount } = summarizeValidationResults(results);

  let flowCount = 0;
  try {
    flowCount = (await discoverFlows(path)).length;
  } catch {}

  if (jsonMode) {
    printMachinePayload(
      createMachineSuccess("validate", {
        path,
        valid: errorCount === 0,
        flowCount,
        errorCount,
        warningCount,
        issues: results,
      }),
    );
  } else if (errorCount === 0 && warningCount === 0) {
    console.log(`✓ ${flowCount} flow(s) valid`);
  } else {
    for (const result of results) {
      if (isValidationIssue(result)) {
        console.log(`✗ ${result.file}: ${result.error}`);
      } else {
        console.log(`! ${result.file}: ${result.message}`);
      }
    }

    if (errorCount === 0) {
      console.log(`✓ ${flowCount} flow(s) valid with ${warningCount} warning(s)`);
    }
  }

  if (errorCount > 0) {
    process.exit(1);
  }
} else if (command === "validate-config") {
  let configPath: string | undefined;
  let jsonMode = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--config" && args[i + 1]) {
      configPath = args[++i];
    } else if (arg === "--json") {
      jsonMode = true;
    } else if (!arg.startsWith("--")) {
      configPath = arg;
    }
  }
  const { loadConfig } = await import("./config-loader.js");
  try {
    const result = await loadConfig({ configPath });
    if (jsonMode) {
      printMachinePayload(
        createMachineSuccess("validate-config", {
          valid: true,
          configPath: result.configPath,
        }),
      );
    } else {
      console.log(`✓ Config valid (${result.configPath})`);
    }
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (jsonMode) {
      printMachinePayload(createMachineFailure("validate-config", configCommandError(message)));
    } else {
      console.log(message);
    }
    process.exit(1);
  }
} else if (command === "doctor") {
  const platforms: Platform[] = [];
  let configPath: string | undefined;
  let driver: "local" | "appium" | undefined;
  let appiumUrl: string | undefined;
  let capsPath: string | undefined;
  let capsJson: string | undefined;
  let jsonMode = false;
  let pretty = false;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--platform" && args[i + 1]) {
      platforms.push(...(args[++i]!.split(",") as Platform[]));
    } else if (arg === "--config" && args[i + 1]) {
      configPath = args[++i];
    } else if (arg === "--driver" && args[i + 1]) {
      driver = args[++i] as "local" | "appium";
    } else if (arg === "--appium-url" && args[i + 1]) {
      appiumUrl = args[++i];
    } else if (arg === "--caps" && args[i + 1]) {
      capsPath = args[++i];
    } else if (arg === "--caps-json" && args[i + 1]) {
      capsJson = args[++i];
    } else if (arg === "--json") {
      jsonMode = true;
    } else if (arg === "--pretty") {
      pretty = true;
    }
  }

  const { runDoctorCommand } = await import("./doctor-command.js");
  const success = await runDoctorCommand({
    configPath,
    platforms,
    driver,
    appiumUrl,
    capsPath,
    capsJson,
    json: jsonMode,
    pretty,
  });
  process.exit(success ? 0 : 1);
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
  let preset: string | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--preset" && args[i + 1]) {
      preset = args[++i];
    }
  }
  if (preset && !isInitPreset(preset)) {
    console.log(
      `Unknown init preset "${preset}". Use one of: local-web, local-react-native, browserstack, saucelabs.`,
    );
    process.exit(1);
  }
  const { runInitCommand } = await import("./init-command.js");
  const success = await runInitCommand({
    force,
    preset: preset && isInitPreset(preset) ? preset : undefined,
  });
  process.exit(success ? 0 : 1);
} else if (command === "init-flow") {
  let name: string | undefined;
  let outputPath: string | undefined;
  let preset: string | undefined;
  let force = false;
  const platforms: Platform[] = [];
  let tags: string[] | undefined;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--platform" && args[i + 1]) {
      platforms.push(...(args[++i]!.split(",") as Platform[]));
    } else if (arg === "--tag" && args[i + 1]) {
      tags = args[++i]!.split(",");
    } else if (arg === "--output" && args[i + 1]) {
      outputPath = args[++i];
    } else if (arg === "--preset" && args[i + 1]) {
      preset = args[++i];
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("--") && !name) {
      name = arg;
    }
  }

  if (!name) {
    console.log(
      "Usage: spana init-flow <name> [--platform web,android,ios] [--tag smoke,auth] [--preset blank|smoke|auth] [--output path] [--force]",
    );
    process.exit(1);
  }

  if (preset && !isFlowStubPreset(preset)) {
    console.log(`Unknown flow stub preset "${preset}". Use one of: blank, smoke, auth.`);
    process.exit(1);
  }

  const { runInitFlowCommand } = await import("./init-flow-command.js");
  const success = await runInitFlowCommand({
    name,
    outputPath,
    platforms,
    tags,
    preset: preset && isFlowStubPreset(preset) ? preset : undefined,
    force,
  });
  process.exit(success ? 0 : 1);
} else if (command === "devices") {
  const jsonMode = args.includes("--json");
  const { discoverDevices } = await import("../device/discover.js");
  const devices = discoverDevices(["web", "android", "ios"]);
  if (jsonMode) {
    printMachinePayload(
      createMachineSuccess("devices", {
        devices,
        count: devices.length,
      }),
    );
  } else if (devices.length === 0) {
    console.log("No devices found.");
  } else {
    for (const d of devices) {
      console.log(`  ${d.platform.padEnd(8)} ${d.name.padEnd(30)} ${d.type.padEnd(10)} ${d.state}`);
    }
  }
} else if (command === "version" || args.includes("--version") || args.includes("-v")) {
  console.log("spana v0.2.0");
} else {
  console.log("spana — TypeScript-native E2E testing for React Native + Web");
  console.log("");
  console.log("Commands:");
  console.log("  spana test [path]              Run test flows");
  console.log("  spana hierarchy --platform <p> Dump element hierarchy as JSON");
  console.log("  spana selectors --platform <p> List actionable elements with suggested selectors");
  console.log("  spana validate [path]          Validate flow files without device connection");
  console.log("  spana validate-config [path]   Validate spana.config.ts without running flows");
  console.log("  spana doctor                  Check environment readiness before running tests");
  console.log("  spana studio                   Launch Spana Studio UI");
  console.log("  spana init                     Initialize a new spana project");
  console.log("  spana init-flow <name>         Generate a starter .flow.ts file");
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
  console.log("  --last-failed              Rerun only flows that failed in the last Spana run");
  console.log("  --changed                  Run only changed flow files from git");
  console.log("  --watch                    Rerun automatically when flow/config files change");
  console.log("  --quiet, -q                Only show failures and final summary");
  console.log("  --device <id>              Target a specific device by ID");
  console.log("  --parallel                 Auto-discover devices and run in parallel");
  console.log("  --workers <n>              Max parallel workers per platform");
  console.log("  --devices <id1>,<id2>      Select specific devices for parallel execution");
  console.log("  --verbose                  Dump detailed failure diagnostics and hierarchy");
  console.log(
    "  --json                     Emit versioned machine-readable output where supported",
  );
  console.log("  --validate-config          Validate config and exit");
  console.log("  --config path              Config file path");
  console.log("  --pretty                   Pretty-print JSON output (hierarchy/selectors)");
  console.log("  --port <number>            Studio port (default: 4400)");
  console.log("  --no-open                  Don't open browser (studio command)");
  console.log("  --preset <name>            Use a preset for init/init-flow");
  console.log("  --output <path>            Output path for init-flow");
  console.log("  --force                    Overwrite existing files (init/init-flow)");
}
