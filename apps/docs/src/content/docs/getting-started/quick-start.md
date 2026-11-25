---
title: Quick Start
description: Install spana, configure it, and run your first flow.
---

## 1. Install

```bash
npm install spana
# or
bun add spana
```

spana works with Node.js 20+ and [Bun](https://bun.sh).

## 2. Create a config file

Create `spana.config.ts` at the root of your project:

```ts
import { defineConfig } from "spana";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.app" },
    ios: { bundleId: "com.example.app" },
  },
  platforms: ["web"],
});
```

Start with `platforms: ["web"]` while getting familiar with the framework, then add `"android"` and `"ios"` once your device targets are set up.

## 3. Write a flow

Create `flows/login.flow.ts`:

```ts
import { flow } from "spana";

export default flow("user can log in", async ({ app, expect }) => {
  await app.tap({ testID: "email-input" });
  await app.inputText("user@example.com");
  await app.tap({ testID: "password-input" });
  await app.inputText("secret");
  await app.tap({ testID: "login-button" });
  await expect({ testID: "home-screen" }).toBeVisible();
});
```

The `testID` selector maps to `data-testid` on web, `accessibilityIdentifier` on iOS, and `resource-id` on Android. It is the preferred selector type.

## 4. Run

```bash
spana test
```

This discovers all `*.flow.ts`, `*.test.ts`, and `*.feature` files under `./flows` (or the `flowDir` in your config) and runs them against the configured platforms. Other `.ts` files in the folder are not picked up as flows.

### Run a single file

```bash
spana test flows/login.flow.ts
```

### Target a specific platform

```bash
spana test --platform android
```

### Filter by tag

```bash
spana test --tag smoke
```

## 5. View results

By default, results print to the console. To get structured JSON output:

```bash
spana test --reporter json
```

On failure, spana captures screenshots and diagnostics under `spana-output/` by default (configurable via `artifacts.outputDir`).

## Next steps

- [Configuration](/getting-started/configuration/) — all `defineConfig` options
- [Flows](/writing-tests/flows/) — `flow()` API, tags, timeouts
- [Selectors](/writing-tests/selectors/) — all selector types
- [CLI Commands](/cli/commands/) — all flags
