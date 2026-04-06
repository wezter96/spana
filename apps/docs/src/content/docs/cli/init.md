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

| Flag      | Description                                     |
| --------- | ----------------------------------------------- |
| `--force` | Overwrite existing `spana.config.ts` if present |

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

## Next steps

After running `spana init`:

1. Install spana: `npm install -D spana-test`
2. Add `spana-output` to your `.gitignore`
3. Edit `flows/example.flow.ts` with selectors from your app
4. Discover selectors: `spana selectors`
5. Run tests: `spana test`
