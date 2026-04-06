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

| Flag                     | Description                                               |
| ------------------------ | --------------------------------------------------------- |
| `--platform <platforms>` | Comma-separated platform targets: `web`, `android`, `ios` |
| `--tag <tag>`            | Run only flows with this tag                              |
| `--grep <pattern>`       | Run only flows whose name matches this pattern            |
| `--reporter <name>`      | Reporter: `console`, `json`, `junit`, `html`              |
| `--config <path>`        | Path to config file (default: `./spana.config.ts`)        |
| `--device <id>`          | Target a specific device by ID (see `spana devices`)      |
| `--retries <n>`          | Retry failed flows n times (enables flake detection)      |

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
```

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
