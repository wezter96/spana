---
title: Init
description: Scaffold a new spana project with interactive prompts.
---

The `spana init` command generates a starter config file and example flow through an interactive wizard.

## Usage

```bash
spana init
```

### Options

| Flag              | Description                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `--force`         | Overwrite existing `spana.config.ts` (and the starter flow) if present                   |
| `--preset <name>` | `local-web`, `local-react-native`, `capacitor-web-first`, `browserstack`, or `saucelabs` |

Only `capacitor-web-first` changes the output today: it skips the wizard (see [below](#capacitor-web-first-preset)). The other preset names are accepted, but Spana still runs the interactive wizard.

## What it does

The wizard asks:

1. **Which platforms to test** -- web (Playwright), Android (UiAutomator2), iOS (WebDriverAgent)
2. **App details** per platform:
   - Web: app URL (default `http://localhost:3000`)
   - Android: package name (default `com.example.myapp`)
   - iOS: bundle ID (default `com.example.myapp`)

Then it creates:

| File                    | Description                                      |
| ----------------------- | ------------------------------------------------ |
| `spana.config.ts`       | Config file with your platform and app settings  |
| `flows/example.flow.ts` | Starter flow with a smoke test you can customize |

## Generated config

```ts title="spana.config.ts"
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    android: { packageName: "com.example.myapp" },
  },
  platforms: ["web", "android"],
  flowDir: "./flows",
  reporters: ["console"],
  defaults: {
    waitTimeout: 5_000,
  },
});
```

## Generated flow

```ts title="flows/example.flow.ts"
import { flow } from "spana-test";

export default flow(
  "Example - app loads successfully",
  { tags: ["smoke"], platforms: ["web", "android"] },
  async ({ app, expect }) => {
    await expect({ text: "Hello" }).toBeVisible();
  },
);
```

## `capacitor-web-first` preset

```bash
spana init --preset capacitor-web-first
```

This preset writes files without prompts:

| File                    | Description                                                                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `spana.config.ts`       | All five targets (`web`, `android`, `ios`, `electron`, `electrobun`) with `execution.bridge` and `execution.warmDaemons` turned on |
| `flows/sign-in.flow.ts` | Sign-in flow that taps a `systemUI()` OAuth sheet                                                                                  |

Install `spana-bridge` in your test builds to use the DOM bridge.

## Next steps

After running `spana init`:

1. Install spana: `npm install -D spana-test`
2. Add `spana-output` to your `.gitignore`
3. Edit `flows/example.flow.ts` with selectors from your app
4. Discover selectors: `spana selectors`
5. Run tests: `spana test`
