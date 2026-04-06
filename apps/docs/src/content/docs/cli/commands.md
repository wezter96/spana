---
title: CLI Commands
description: All spana CLI commands and flags.
---

The `spana` binary is the entry point for running tests, listing devices, and introspecting the platform state.

## `spana test`

Run test flows.

```bash
spana test [path] [options]
```

`path` is optional. If omitted, spana discovers all `.ts` files under `flowDir` (default: `./flows`).

### Options

| Flag                        | Description                                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `--platform <platforms>`    | Comma-separated platform targets: `web`, `android`, `ios`            |
| `--tag <tag>`               | Run only flows with this tag                                         |
| `--grep <pattern>`          | Run only flows whose name matches this pattern                       |
| `--reporter <name>`         | Reporter: `console`, `json`, `junit`, `html`, `allure`               |
| `--config <path>`           | Path to config file                                                  |
| `--validate-config`         | Validate config and exit without discovering or running flows        |
| `--device <id>`             | Target a specific local device by ID (see `spana devices`)           |
| `--retries <n>`             | Retry failed flows n times (enables flake detection)                 |
| `--shard <current>/<total>` | Run only one deterministic CI shard of the filtered flow set         |
| `--bail <n>`                | Stop scheduling new flows after `n` final flow failures              |
| `--debug-on-failure`        | Drop into an interactive REPL after the first failed flow (TTY only) |
| `--driver <local\|appium>`  | Override execution mode from config                                  |
| `--appium-url <url>`        | Appium server URL for cloud or remote execution                      |
| `--caps <path>`             | Path to Appium capabilities JSON file                                |
| `--caps-json <json>`        | Inline Appium capabilities JSON                                      |
| `--no-provider-reporting`   | Skip provider result updates for Appium cloud sessions               |

### Examples

```bash
# Run all flows against web (config default)
spana test

# Run a single flow file
spana test flows/login.ts

# Run all smoke-tagged flows on Android and iOS
spana test --tag smoke --platform android,ios

# Filter by name pattern
spana test --grep "log in"

# Emit JSON to stdout for downstream processing
spana test --reporter json

# Use a non-default config
spana test --config ./config/spana.staging.ts

# Target a specific device (platform is inferred)
spana test --device emulator-5554

# Target a specific iOS simulator
spana test --device "SIM-UDID-HERE"

# Retry flaky tests twice
spana test --retries 2

# Validate config only
spana test --validate-config

# Split flows across two CI jobs
spana test --shard 1/2

# Stop after the first failed flow
spana test --bail 1

# Open a REPL on the first failure
spana test --debug-on-failure
```

### Precedence

For `spana test`, CLI flags override `spana.config.ts`.

1. `--driver` overrides `execution.mode`
2. `--appium-url` overrides `execution.appium.serverUrl`
3. `--platform`, `--reporter`, and `--retries` override config defaults
4. Filtering happens before sharding, so each shard sees the already-filtered flow list

## `spana validate-config`

Validate `spana.config.ts` without running flows.

```bash
spana validate-config [path]
```

This loads the config module, validates it against Spana's runtime schema, and prints the resolved file path on success.

## `spana devices`

List connected devices and simulators across all platforms.

```bash
spana devices
```

Output includes device name, platform, OS version, and connection status. Useful for confirming your device targets before running tests.

```bash
spana devices
# android  Pixel 7          API 33   connected
# ios      iPhone 15        17.2     booted (simulator)
```

## `spana version`

Print the installed spana version and exit.

```bash
spana version
# spana 0.1.0
```

## Exit codes

| Code | Meaning                      |
| ---- | ---------------------------- |
| `0`  | All flows passed             |
| `1`  | One or more flows failed     |
| `2`  | Configuration or setup error |
