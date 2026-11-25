import { createInterface } from "node:readline/promises";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { stdin, stdout } from "node:process";

interface InitOptions {
  force: boolean;
  preset?: string;
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

function generateWebFirstPresetConfig(): string {
  return `import { defineConfig } from "spana-test";

export default defineConfig({
  platforms: ["web", "android", "ios", "electron", "electrobun"],
  flowDir: "./flows",
  reporters: ["console"],
  defaults: {
    waitTimeout: 5_000,
    tapMode: "native",
    locale: "en_US",
  },
  execution: {
    bridge: { enabled: true, port: 9333 },
    warmDaemons: { enabled: true, reuseSession: true },
  },
  apps: {
    web: { url: "http://localhost:5173" },
    android: { packageName: "com.example.myapp" },
    ios: { bundleId: "com.example.myapp" },
    electron: { entry: "./dist-electron/main.js" },
    electrobun: { executablePath: "./build/MyApp.app/Contents/MacOS/MyApp", renderer: "native" },
  },
});
`;
}

function generateWebFirstExampleFlow(): string {
  return `import { flow, systemUI } from "spana-test";

export default flow(
  "OAuth sign-in across web, Capacitor, Electron, and Electrobun",
  { tags: ["smoke", "auth"], platforms: ["web", "android", "ios", "electron", "electrobun"] },
  async ({ app, expect }) => {
    // DOM channel finds data-testid (~1ms), native channel performs a real touch on mobile
    await app.tap({ testID: "sign-in" });

    // Out-of-process OAuth sheet (SFSafariViewController / Chrome Custom Tab)
    await app.tap(systemUI({ text: "Continue" }));

    // Back in the webview: resolved via DOM channel with zero native page-source dumps
    await expect({ testID: "profile-id" }).toBeVisible();
  },
);
`;
}

export async function runInitCommand(options: InitOptions): Promise<boolean> {
  if (existsSync("spana.config.ts") && !options.force) {
    console.log("\n  spana.config.ts already exists. Use --force to overwrite.\n");
    return false;
  }

  if (options.preset === "capacitor-web-first") {
    writeFileSync("spana.config.ts", generateWebFirstPresetConfig());
    if (!existsSync("flows")) {
      mkdirSync("flows", { recursive: true });
    }
    if (!existsSync("flows/sign-in.flow.ts") || options.force) {
      writeFileSync("flows/sign-in.flow.ts", generateWebFirstExampleFlow());
    }
    console.log("\n  Created web-first 5-target spana.config.ts and flows/sign-in.flow.ts");
    console.log(
      "  Install `spana-bridge` in test builds for instant DOM queries, idle(), and resetFast().\n",
    );
    return true;
  }

  console.log("\n  Setting up spana...\n");

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const web = await confirm(rl, "Test on web (Playwright)?");
    const android = await confirm(rl, "Test on Android (UiAutomator2)?");
    const ios = await confirm(rl, "Test on iOS (WebDriverAgent)?");

    if (!web && !android && !ios) {
      console.log("\n  No platforms selected. At least one is required.\n");
      return false;
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
    return true;
  } finally {
    rl.close();
  }
}
