---
title: Studio
description: Local web UI for interactive element inspection and test management.
---

Spana Studio is a local web interface that bundles an **Element Inspector**, a **Test Runner Dashboard**, and a **Recorder** into a single tool. It lets you visually inspect device screens, explore element trees, record new flows, and run test flows with real-time feedback — all from your browser.

## Launching Studio

```bash
spana studio [options]
```

### Options

| Flag              | Description                                        |
| ----------------- | -------------------------------------------------- |
| `--port <number>` | Port to serve on (default: `4400`)                 |
| `--no-open`       | Don't auto-open the browser                        |
| `--config <path>` | Path to config file (default: `./spana.config.ts`) |

```bash
# Start on the default port and open the browser
spana studio

# Use a custom port, skip auto-open
spana studio --port 4000 --no-open

# Point at a non-default config
spana studio --config ./config/spana.staging.ts
```

## Element Inspector

![Studio Inspector](../../../assets/studio-inspector.png)

Connect to a running device or simulator, then interact with a live screenshot of the current screen.

- **Tap to inspect** — click any element in the screenshot to see its properties (testID, text, accessibility label, bounds).
- **Element tree** — browse the full hierarchy in a sidebar tree view.
- **Copy selectors** — one-click copy of the best selector for any element, ready to paste into a flow file.

This gives you the same information as `spana selectors` and `spana hierarchy`, but in a visual, point-and-click workflow.

## Test Runner Dashboard

![Studio Test Runner](../../../assets/studio-runner.png)

Discover and run flow files without leaving the browser.

- **Flow discovery** — automatically lists all flows found under your configured `flowDir`.
- **Device selector** — pick the target device, emulator, or simulator for each selected platform from the toolbar.
- **Run tests** — execute one or many flows with real-time progress updates.
- **Step details** — expand any step to see its status, duration, and captured screenshot.

### Capture toggles

Two checkboxes control screenshot capture during a run:

| Toggle            | Behavior                                                                             |
| ----------------- | ------------------------------------------------------------------------------------ |
| **Screenshots**   | Also capture artifacts when a flow passes (`artifacts.captureOnSuccess`)             |
| **Step captures** | Capture per-step screenshots (`artifacts.captureSteps`), useful for visual debugging |

When either toggle is on, failure capture, screenshots, and UI hierarchy dumps are also turned on for that run.

### Session persistence

Test results persist across tab switches within the same Studio session. You can jump between the Inspector, Runner, and Recorder without losing run history or step details.

## Recorder

Record a new flow by driving a live web, Android, or iOS session from Studio.

- **Start Recording** — open a recording session for the selected platform and device.
- **Record actions** — click the screenshot to tap, double-tap, long-press, type text, or add an `expect(...).toBeVisible()` check; use the toolbar for tap, type text, scroll, swipe, and back. Each action runs on the device, and Studio stores the selector and alternative selectors for it.
- **Delete** — remove a recorded action.
- **Generate / Save** — generate flow code from the recorded actions, or save it to `<flowDir>/<flow name>.ts` (default `flows/`).

## How it works

Studio is an embedded React frontend served directly from the CLI binary — no separate install required. The frontend communicates with the CLI backend through an oRPC API layer, giving you type-safe requests between the browser and device connections.

## Development

If you're working on Studio itself, run the Vite dev server with hot reload:

```bash
cd apps/studio
bun run dev
```

The Vite dev server runs on port `4401`. The frontend sends its API calls to `/rpc` on the page's own origin.
