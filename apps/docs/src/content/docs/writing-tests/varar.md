---
title: Varar (Markdown specs)
description: Run Varar Markdown documents as tests, with Spana driving web, iOS, Android and desktop apps.
---

[Varar](https://varar.dev) turns plain Markdown documents into tests. A value in a sentence is
either an input (a **stimulus**) or an expected output (a **sensor**). If the app returns a
different value, the test fails. There are no `Given`/`When`/`Then` keywords.

Varar runs inside Vitest. Spana does not run `.md` files itself. Instead, your step functions call
Spana's [Agent API](/reference/agent-api/) (`connect()` from `spana/agent`) to drive the
app.

:::note[Which one to pick]
Use Varar when you want specs that read like normal documentation. Use [Gherkin](/writing-tests/gherkin/)
when you already have `.feature` files. Use plain [flows](/writing-tests/flows/) for the fastest
runs: only `spana test` gives you the shared browser pool, `--changed-since` filters, reports and
platform tags.
:::

A full working project is in
[`examples/varar`](https://github.com/wezter96/spana/tree/main/examples/varar).

## Install

```bash
npm install -D spana @varar/varar @varar/vitest @varar/cli vitest vite
```

Your `package.json` must have `"type": "module"`.

## Configure

```json title="varar.config.json"
{ "docs": { "include": ["varar/**/*.md"], "exclude": [] }, "steps": ["src/varar/**/*.steps.ts"] }
```

```ts title="vitest.config.ts"
import vararPlugin from "@varar/vitest";
import { VararResultsReporter } from "@varar/vitest/reporter";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [vararPlugin()],
  test: { testTimeout: 30_000, reporters: ["default", new VararResultsReporter()] },
});
```

The Varar plugin replaces Vitest's `test.include` with the `docs.include` list.

## Write the spec

```md title="varar/cart.md"
# Shopping cart

A new visitor sees that the cart shows 0 items.

When the shopper adds 2 items to the cart, the cart shows 2 items.
```

## Write the steps

```ts title="src/varar/cart.steps.ts"
import { steps } from "@varar/varar";
import { connect, type Session } from "spana/agent";
import { afterAll } from "vitest";

let session: Session | undefined;
afterAll(() => session?.disconnect());

// The state factory runs for each document. Reuse one session, relaunch the app.
const { stimulus, sensor } = steps(async () => {
  session ??= await connect({ platform: "web", baseUrl: "http://localhost:4173" });
  await session.launch();
  return { app: session };
});

stimulus("the shopper adds {int} items to the cart", async ({ app }, count) => {
  for (let i = 0; i < count; i++) await app.tap({ testID: "add-to-cart" });
});

// Read a value by testID. selectors() works on web, iOS, Android and desktop.
async function textOf(app: Session, testID: string) {
  return (await app.selectors()).find((el) => el.id === testID)?.text;
}

sensor("the cart shows {int} items", async ({ app }) => Number(await textOf(app, "cart-count")));
```

Run it:

```bash
npx vitest run
```

If the app shows a different number, Varar reports the cell that does not match:

```
CellMismatchError: cell 1: expected 3 but was 2
```

## Other platforms

Change the `connect()` options. The steps stay the same, because `{ testID }` selectors work on
every platform:

```ts
await connect({ platform: "android", packageName: "com.example.app" });
await connect({ platform: "ios", bundleId: "com.example.app" });
```

See [`connect()` options](/reference/agent-api/) for Electron and Electrobun.

## Limits

- Runs one session at a time in each Vitest worker. Spana's shared pool and `--parallel` are not
  used.
- `--changed-since`, Spana reporters and `@web`/`@ios` tags do not apply. Use Vitest's own
  filters and reporters.
- Varar is at version 0.8. Its API can change.
