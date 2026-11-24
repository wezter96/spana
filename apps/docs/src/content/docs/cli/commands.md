---
title: CLI Commands
description: Full command and flag reference for the spana CLI.
---

The `spana` binary is the entry point for running flows, validating projects, inspecting live UI state, and scaffolding new tests.

## `spana test`

Run discovered flows or a specific file.

```bash
spana test [path] [options]
```

`path` is optional. If omitted, Spana discovers flows from `flowDir` in `spana.config.ts`.

### Filtering and targeting

| Flag                           | Description                                  |
| ------------------------------ | -------------------------------------------- |
| `--platform <web,android,ios>` | Restrict the run to one or more platforms    |
| `--tag <tag1,tag2>`            | Run only flows with matching tags            |
| `--grep <pattern>`             | Run only flows whose names match the pattern |
| `--device <id>`                | Run on one specific local device             |
| `--devices <id1>,<id2>`        | Run on specific devices in parallel mode     |

### Parallelism and execution control

| Flag                        | Description                                        |
| --------------------------- | -------------------------------------------------- |
| `--parallel`                | Auto-discover devices and run flows in parallel    |
| `--workers <n>`             | Max workers per platform in parallel mode          |
| `--retries <n>`             | Retry failed flows `n` times                       |
| `--bail <n>`                | Stop scheduling new flows after `n` final failures |
| `--shard <current>/<total>` | Run one deterministic CI shard                     |
| `--debug-on-failure`        | Open an interactive REPL on the first failure      |

### Iteration helpers

| Flag                 | Description                                        |
| -------------------- | -------------------------------------------------- |
| `--watch`            | Re-run when flows or config change                 |
| `--changed`          | Run only changed flow files from git               |
| `--last-failed`      | Re-run only flows that failed in the last run      |
| `--update-baselines` | Rewrite screenshot baselines for visual regression |

### Output and configuration

| Flag                | Description                                                                     |
| ------------------- | ------------------------------------------------------------------------------- |
| `--reporter <name>` | Reporter: `console`, `json`, `junit`, `html`, `allure`, or a custom module path |
| `--config <path>`   | Use a non-default config file                                                   |
| `--validate-config` | Validate config and exit before discovery                                       |
| `--quiet`, `-q`     | Suppress pass output and show failures plus summary                             |
| `--verbose`         | Print detailed failure diagnostics and hierarchy                                |
| `--json`            | Emit machine-readable output where supported                                    |

### Appium and cloud overrides

| Flag                       | Description                                           |
| -------------------------- | ----------------------------------------------------- |
| `--driver <local\|appium>` | Override `execution.mode`                             |
| `--appium-url <url>`       | Override `execution.appium.serverUrl`                 |
| `--caps <path>`            | Load Appium capabilities from JSON                    |
| `--caps-json <json>`       | Inline Appium capabilities JSON                       |
| `--no-provider-reporting`  | Skip BrowserStack/Sauce Labs session result reporting |

### Examples

```bash
# Run the whole suite
spana test

# Run one file on web
spana test flows/login.flow.ts --platform web

# Run smoke flows on Android and iOS
spana test --tag smoke --platform android,ios

# Run the last failures only
spana test --last-failed

# Re-run automatically while editing flows
spana test --watch

# Parallelize across discovered devices
spana test --parallel --workers 2

# Pin the run to specific devices
spana test --platform android,ios --devices emulator-5554,SIM-1

# Refresh screenshot baselines
spana test --update-baselines
```

### Framework-app multi-device showcase

When you want a concrete local showcase run from this repo, start in `packages/spana` so the bundled framework demo config and flows resolve directly:

```bash
# Inspect the device IDs you can target
spana devices

# Iterate on one pinned device first
spana test ./flows/framework-app --config ./spana.config.ts --platform android --device emulator-5554

# Then fan out the same showcase flows across specific Android + iOS targets
spana test ./flows/framework-app \
  --config ./spana.config.ts \
  --platform android,ios \
  --devices emulator-5554,<ios-simulator-id> \
  --parallel \
  --workers 1
```

Use `--device` when you want one reproducible local target while debugging a flow, then switch to `--devices` plus `--parallel` when you want the framework-app demo to showcase the same suite across multiple local devices.

CLI flags override `spana.config.ts`. Filtering happens before sharding, so each shard sees a deterministic slice of the already-filtered flow list.

## `spana hierarchy`

Dump the current UI hierarchy from a live session.

```bash
spana hierarchy --platform <web|android|ios> [--config path] [--json] [--pretty]
```

Use this to inspect the raw element tree when selectors are not behaving as expected.

## `spana selectors`

List actionable elements and suggested selectors for the current screen.

```bash
spana selectors --platform <web|android|ios> [--config path] [--json] [--pretty]
```

This command connects to the running app, inspects the hierarchy, and returns the best selectors Spana can infer for each visible element.

For deeper examples of both commands, see [Agent Commands](/cli/agent-commands/).

## `spana validate`

Validate flow files without connecting to devices.

```bash
spana validate [path] [--json]
```

`path` defaults to `./flows`. Validation checks that flows load correctly and that project-level flow issues are surfaced before a real run.

## `spana validate-config`

Validate `spana.config.ts` without starting drivers or discovering flows.

```bash
spana validate-config [path] [--config path] [--json]
```

This is useful in CI or pre-commit hooks when you want a fast config sanity check.

## `spana doctor`

Check environment readiness before running tests.

```bash
spana doctor [options]
```

| Flag                           | Description                             |
| ------------------------------ | --------------------------------------- |
| `--platform <web,android,ios>` | Limit diagnostics to selected platforms |
| `--config <path>`              | Load a specific config file             |
| `--driver <local\|appium>`     | Force local or Appium diagnostics       |
| `--appium-url <url>`           | Override the Appium endpoint under test |
| `--caps <path>`                | Load Appium capabilities from a file    |
| `--caps-json <json>`           | Inline Appium capabilities JSON         |
| `--json`                       | Emit machine-readable doctor results    |
| `--pretty`                     | Pretty-print JSON output                |

Use `doctor` before a new CI environment, after simulator/device setup changes, or when a session fails to start and you want a quick readiness report.

## `spana studio`

Launch the Studio UI for recording, inspection, and running flows.

```bash
spana studio [--config path] [--port 4400] [--no-open]
```

See [Studio](/cli/studio/) for the full workflow.

## `spana init`

Scaffold a new Spana project.

```bash
spana init [--preset <local-web|local-react-native|browserstack|saucelabs>] [--force]
```

See [Init](/cli/init/) for the generated config and starter flow.

## `spana init-flow`

Generate a starter `.flow.ts` file.

```bash
spana init-flow <name> [options]
```

| Flag                           | Description                             |
| ------------------------------ | --------------------------------------- | ------ | ----------------------------------- |
| `--platform <web,android,ios>` | Add platform tags to the generated flow |
| `--tag <tag1,tag2>`            | Add custom tags                         |
| `--preset <blank               | smoke                                   | auth>` | Start from a built-in flow template |
| `--output <path>`              | Write to a custom file path             |
| `--force`                      | Overwrite an existing file              |

### Examples

```bash
spana init-flow "checkout smoke" --preset smoke --platform web,android --tag smoke
spana init-flow "login auth" --preset auth --output flows/auth/login.flow.ts
```

## `spana devices`

List connected devices and simulators.

```bash
spana devices [--json]
```

Output includes platform, device name, device type, and connection state. This is the fastest way to confirm the IDs you should pass to `--device` or `--devices`.

## `spana version`

Print the installed CLI version.

```bash
spana version
```

## Exit codes

| Code | Meaning           |
| ---- | ----------------- |
| `0`  | Command succeeded |
| `1`  | Command failed    |
