import type { Platform } from "../schemas/selector.js";

const args = process.argv.slice(2);
const command = args[0];

if (command === "test") {
  const platforms: Platform[] = [];
  let tags: string[] | undefined;
  let grep: string | undefined;
  let reporter = "console";
  let configPath: string | undefined;
  let flowPath: string | undefined;

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
    } else if (!arg.startsWith("--")) {
      flowPath = arg;
    }
  }

  if (platforms.length === 0) {
    platforms.push("web");
  }

  const { runTestCommand } = await import("./test-command.js");
  const success = await runTestCommand({
    platforms,
    tags,
    grep,
    reporter,
    configPath,
    flowPath,
  });
  process.exit(success ? 0 : 1);
} else if (
  command === "version" ||
  args.includes("--version") ||
  args.includes("-v")
) {
  console.log("prov v0.0.1");
} else {
  console.log("prov — TypeScript-native E2E testing for React Native + Web");
  console.log("");
  console.log("Commands:");
  console.log("  prov test [path]     Run test flows");
  console.log("  prov version         Show version");
  console.log("");
  console.log("Options:");
  console.log(
    "  --platform web,android,ios  Platforms to test (default: web)",
  );
  console.log("  --tag smoke,auth           Filter by tags");
  console.log("  --grep login               Filter by name pattern");
  console.log(
    "  --reporter console|json    Reporter format (default: console)",
  );
  console.log("  --config path              Config file path");
}
