# `spana init` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `spana init` command that interactively scaffolds a spana config and example flow file.

**Architecture:** Single new file `init-command.ts` handles interactive prompts via Node.js `readline`, generates two files, and prints next steps. Registered in the CLI entry point alongside existing commands.

**Tech Stack:** TypeScript, Node.js readline

---

## File Map

| Task            | Create                                   | Modify                            |
| --------------- | ---------------------------------------- | --------------------------------- |
| 1. Init command | `packages/spana/src/cli/init-command.ts` | `packages/spana/src/cli/index.ts` |

All paths relative to `/Users/anton/.superset/projects/spana/`.

---

### Task 1: `spana init` Command

**Files:**

- Create: `packages/spana/src/cli/init-command.ts`
- Modify: `packages/spana/src/cli/index.ts`

- [ ] **Step 1: Create the init command module**

```typescript
// packages/spana/src/cli/init-command.ts
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
    // Platform selection
    const web = await confirm(rl, "Test on web (Playwright)?");
    const android = await confirm(rl, "Test on Android (UiAutomator2)?");
    const ios = await confirm(rl, "Test on iOS (WebDriverAgent)?");

    if (!web && !android && !ios) {
      console.log("\n  No platforms selected. At least one is required.\n");
      process.exit(1);
    }

    console.log("");

    // App identifiers
    const webUrl = web ? await prompt(rl, "Web app URL", "http://localhost:3000") : "";
    const androidPackage = android
      ? await prompt(rl, "Android package name", "com.example.myapp")
      : "";
    const iosBundleId = ios ? await prompt(rl, "iOS bundle ID", "com.example.myapp") : "";

    const answers: PlatformAnswers = { web, android, ios, webUrl, androidPackage, iosBundleId };
    const platforms = [web && "web", android && "android", ios && "ios"].filter(
      Boolean,
    ) as string[];

    // Generate files
    writeFileSync("spana.config.ts", generateConfig(answers));
    console.log("\n  Created spana.config.ts");

    if (!existsSync("flows")) {
      mkdirSync("flows", { recursive: true });
    }
    if (!existsSync("flows/example.flow.ts") || options.force) {
      writeFileSync("flows/example.flow.ts", generateExampleFlow(platforms));
      console.log("  Created flows/example.flow.ts");
    }

    // Next steps
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
```

- [ ] **Step 2: Register the command in the CLI entry point**

In `packages/spana/src/cli/index.ts`, find the command routing section. After the `studio` block (around line 135) and before the `devices` block, add:

```typescript
} else if (command === "init") {
  const force = args.includes("--force");
  const { runInitCommand } = await import("./init-command.js");
  await runInitCommand({ force });
```

Also add to the help text section (around line 150), alongside the other commands:

```typescript
console.log("  init                        Initialize a new spana project");
```

And in the options section:

```typescript
console.log("  --force                     Overwrite existing files");
```

- [ ] **Step 3: Build and verify**

```bash
cd packages/spana && bun run build
```

Expected: Build succeeds.

- [ ] **Step 4: Test the command manually**

```bash
cd /tmp && mkdir spana-init-test && cd spana-init-test
node /Users/anton/.superset/projects/spana/packages/spana/dist/cli.js init
```

Answer: Y, n, n, accept default URL. Verify:

- `spana.config.ts` exists with `web` platform
- `flows/example.flow.ts` exists
- Next steps printed

```bash
cat spana.config.ts
cat flows/example.flow.ts
rm -rf /tmp/spana-init-test
```

- [ ] **Step 5: Test --force and existing config guard**

```bash
cd /tmp && mkdir spana-init-test && cd spana-init-test
echo "existing" > spana.config.ts
node /Users/anton/.superset/projects/spana/packages/spana/dist/cli.js init
# Should abort with "already exists" message

node /Users/anton/.superset/projects/spana/packages/spana/dist/cli.js init --force
# Should overwrite and succeed

rm -rf /tmp/spana-init-test
```

- [ ] **Step 6: Commit**

```bash
git add packages/spana/src/cli/init-command.ts packages/spana/src/cli/index.ts
git commit -m "feat: add 'spana init' scaffolding command"
```

---

## Execution Order

Single task — no dependencies.
