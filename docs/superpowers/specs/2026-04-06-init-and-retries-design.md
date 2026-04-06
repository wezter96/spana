# `spana init` + `--retries` — Design Spec

## 1. `spana init`

Interactive scaffolding command that creates a minimal project setup.

### Flow

```
$ spana init

? Which platforms? (space to select)
  > [x] web
    [x] android
    [ ] ios

? Web app URL: (http://localhost:3000)
? Android package name: (com.example.myapp)

  Created spana.config.ts
  Created flows/example.flow.ts

  Next steps:
    1. npm install -D spana-test
    2. Add "spana-output" to your .gitignore
    3. Run: npx spana test
```

### Behavior

- Prompts for platforms (multi-select: web, android, ios)
- For each selected platform, prompts for the app identifier:
  - web: URL (default `http://localhost:3000`)
  - android: package name (default `com.example.myapp`)
  - ios: bundle ID (default `com.example.myapp`)
- Generates `spana.config.ts` with the selected platforms and app configs
- Generates `flows/example.flow.ts` with a simple flow that navigates and asserts visibility
- Prints next steps to terminal
- If `spana.config.ts` already exists, aborts with message (use `--force` to overwrite)

### Generated files

**spana.config.ts:**

```typescript
import { defineConfig } from "spana-test";

export default defineConfig({
  apps: {
    web: { url: "http://localhost:3000" },
    // android/ios only if selected
  },
  platforms: ["web"],
  flowDir: "./flows",
  reporters: ["console"],
});
```

**flows/example.flow.ts:**

```typescript
import { flow } from "spana-test";

export default flow(
  "Example - app loads successfully",
  { tags: ["smoke"], platforms: ["web"] },
  async ({ app, expect }) => {
    // Replace with your app's actual selector
    await expect({ text: "Hello" }).toBeVisible();
  },
);
```

### Implementation

- New file: `packages/spana/src/cli/init-command.ts`
- Uses Node.js `readline` for prompts (no extra dependencies)
- Registered in `packages/spana/src/cli/index.ts` as `spana init [--force]`

---

## 2. `--retries` (retry & flake detection)

Re-run failed flows up to N times. Flows that fail then pass on retry are marked as "flaky".

### CLI

```
spana test --retries 2       # retry failed flows up to 2 times
```

### Config

```typescript
export default defineConfig({
  defaults: {
    retries: 0, // already in schema, default 0 (no retries)
  },
});
```

CLI `--retries` flag overrides config value.

### Behavior

1. Run all flows normally
2. Collect failures
3. For each failed flow, re-run up to `retries` times
4. If a flow passes on retry: mark as `flaky` (status remains `passed`, but `flaky: true` flag set)
5. If a flow fails all retries: mark as `failed` with the last attempt's error
6. Retry counter resets per flow (each flow gets up to N retries independently)

### Result shape

The `FlowResult` type gets a `retries` field:

```typescript
interface FlowResult {
  // ... existing fields
  flaky?: boolean; // true if passed after retry
  attempt?: number; // which attempt succeeded (1-based)
  totalAttempts?: number; // total attempts made
}
```

### Reporting

**Console:**

```
  ✓ [web] Login test (1.2s)
  ✓ [web] Checkout flow (flaky, passed on attempt 2/3) (3.4s)
  ✗ [web] Payment flow (failed after 3 attempts) (8.1s)
```

**JSON:** `flowPass` events include `flaky`, `attempt`, `totalAttempts` fields.

**JUnit:** Flaky tests marked with `<flaky/>` element (JUnit 10 format) or a property.

**HTML:** Flaky tests shown with a yellow/amber indicator instead of green.

**RunSummary:** The existing `flaky` counter is incremented for each flaky flow.

### Implementation

- Modify: `packages/spana/src/core/orchestrator.ts` — add retry loop around flow execution
- Modify: `packages/spana/src/cli/index.ts` — parse `--retries N` flag
- Modify: `packages/spana/src/report/console.ts` — show flaky/retry info
- Modify: `packages/spana/src/report/json.ts` — include retry fields
- Modify: `packages/spana/src/report/types.ts` — add `flaky`, `attempt`, `totalAttempts` to FlowResult
