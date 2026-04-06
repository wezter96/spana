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
  });
  process.exit(success ? 0 : 1);
} else if (command === "hierarchy" || command === "selectors") {
  let platform: Platform = "web";
  let pretty = false;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--platform" && args[i + 1]) platform = args[++i] as Platform;
    if (args[i] === "--pretty") pretty = true;
  }
  // Load config for baseUrl/packageName/bundleId
  const { resolve } = await import("node:path");
  let config: Record<string, any> = {};
  try {
    const mod = await import(resolve("spana.config.ts"));
    config = mod.default ?? {};
  } catch {
    /* no config */
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
  const { discoverFlows } = await import("../core/runner.js");
  const { validateFlows } = await import("../core/validator.js");
  const paths = await discoverFlows(path);
  const errors = await validateFlows(paths);
  if (errors.length === 0) {
    console.log(`✓ ${paths.length} flow(s) valid`);
  } else {
    for (const e of errors) console.log(`✗ ${e.file}: ${e.error}`);
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
  // Load config — try explicit path, then common locations
  const { resolve, dirname } = await import("node:path");
  const { existsSync } = await import("node:fs");
  let config: Record<string, any> = {};
  const candidates = configPath
    ? [resolve(configPath)]
    : [resolve("spana.config.ts"), resolve("packages/spana/spana.config.ts")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        // Try direct import first (works under Bun)
        const mod = await import(candidate);
        config = mod.default ?? {};
      } catch {
        // Fall back to spawning bun to evaluate the config (Node.js can't import .ts)
        try {
          const { execSync } = await import("node:child_process");
          const json = execSync(
            `bun -e "import c from '${candidate}'; console.log(JSON.stringify(c))"`,
            { encoding: "utf-8", timeout: 10_000 },
          ).trim();
          config = JSON.parse(json);
        } catch {
          continue;
        }
      }
      // Resolve relative paths in config relative to config file location
      const configDir = dirname(candidate);
      if (config.flowDir && !config.flowDir.startsWith("/")) {
        config.flowDir = resolve(configDir, config.flowDir);
      }
      if (config.artifacts?.outputDir && !config.artifacts.outputDir.startsWith("/")) {
        config.artifacts.outputDir = resolve(configDir, config.artifacts.outputDir);
      }
      break;
    }
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
  console.log("  --config path              Config file path");
  console.log("  --pretty                   Pretty-print JSON output (hierarchy command)");
  console.log("  --port <number>            Studio port (default: 4400)");
  console.log("  --no-open                  Don't open browser (studio command)");
  console.log("  --force                    Overwrite existing files (init command)");
}
