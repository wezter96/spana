import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { stdin, stdout } from "node:process";

interface InitOptions {
  force: boolean;
}

interface PlatformAnswers {
  web: boolean;
  android: boolean;
  ios: boolean;
  webUrl: string;
  androidPackage: string;
  iosBundleId: string;
}

async function prompt(
  rl: ReturnType<typeof createInterface>,
  question: string,
  defaultValue: string,
): Promise<string> {
  const answer = await rl.question(`  ${question} (${defaultValue}): `);
  return answer.trim() || defaultValue;
}

async function confirm(rl: ReturnType<typeof createInterface>, question: string): Promise<boolean> {
  const answer = await rl.question(`  ${question} (Y/n): `);
  return answer.trim().toLowerCase() !== "n";
}

function generateConfig(answers: PlatformAnswers): string {
  const apps: string[] = [];
  const platforms: string[] = [];

  if (answers.web) {
    apps.push(`    web: { url: "${answers.webUrl}" },`);
    platforms.push('"web"');
  }
  if (answers.android) {
    apps.push(`    android: { packageName: "${answers.androidPackage}" },`);
    platforms.push('"android"');
  }
  if (answers.ios) {
    apps.push(`    ios: { bundleId: "${answers.iosBundleId}" },`);
    platforms.push('"ios"');
  }

  return `import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
${apps.join("\n")}
  },
  platforms: [${platforms.join(", ")}],
  flowDir: "./flows",
  reporters: ["console"],
  defaults: {
    waitTimeout: 5_000,
  },
});
`;
}

function generateExampleFlow(platforms: string[]): string {
  const platformsArr = platforms.map((p) => `"${p}"`).join(", ");
  return `import { flow } from "spana-test";

export default flow(
  "Example - app loads successfully",
  { tags: ["smoke"], platforms: [${platformsArr}] },
  async ({ app, expect }) => {
    // Replace the selector below with one from your app.
    // Run "spana selectors" to discover available selectors.
    await expect({ text: "Hello" }).toBeVisible();
  },
);
`;
}

export async function runInitCommand(options: InitOptions) {
  if (existsSync("spana.config.ts") && !options.force) {
    console.log("\n  spana.config.ts already exists. Use --force to overwrite.\n");
    process.exit(1);
  }

  console.log("\n  Setting up spana...\n");

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const web = await confirm(rl, "Test on web (Playwright)?");
    const android = await confirm(rl, "Test on Android (UiAutomator2)?");
    const ios = await confirm(rl, "Test on iOS (WebDriverAgent)?");

    if (!web && !android && !ios) {
      console.log("\n  No platforms selected. At least one is required.\n");
      process.exit(1);
    }

    console.log("");

    const webUrl = web ? await prompt(rl, "Web app URL", "http://localhost:3000") : "";
    const androidPackage = android
      ? await prompt(rl, "Android package name", "com.example.myapp")
      : "";
    const iosBundleId = ios ? await prompt(rl, "iOS bundle ID", "com.example.myapp") : "";

    const answers: PlatformAnswers = { web, android, ios, webUrl, androidPackage, iosBundleId };
    const platforms = [web && "web", android && "android", ios && "ios"].filter(
      Boolean,
    ) as string[];

    writeFileSync("spana.config.ts", generateConfig(answers));
    console.log("\n  Created spana.config.ts");

    if (!existsSync("flows")) {
      mkdirSync("flows", { recursive: true });
    }
    if (!existsSync("flows/example.flow.ts") || options.force) {
      writeFileSync("flows/example.flow.ts", generateExampleFlow(platforms));
      console.log("  Created flows/example.flow.ts");
    }

    console.log("\n  Next steps:");
    console.log("    1. npm install -D spana-test");
    console.log('    2. Add "spana-output" to your .gitignore');
    console.log("    3. Edit flows/example.flow.ts with your app's selectors");
    console.log("    4. Run: npx spana test");
    console.log("");
  } finally {
    rl.close();
  }
}
