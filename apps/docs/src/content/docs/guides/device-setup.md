---
title: Device Setup
description: Set up Android emulators, iOS simulators, and physical devices for testing.
---

Spana auto-discovers available devices for each platform. This guide covers how to set up and verify your devices before running tests.

## Checking available devices

```bash
spana devices
```

This lists discovered devices for all platforms (web, Electron, Electrobun, Android, iOS) as platform, name, type, and state:

```
  web         Chromium (Playwright)                browser    available
  electron    Electron (Playwright _electron / CDP) desktop    available
  electrobun  Electrobun (Native WebView / CEF)    desktop    available
  android     emulator-5554                        emulator   device
  ios         iPhone 16 (iOS.18.4)                 simulator  Booted
  ios         iPhone 16 Pro (iOS.18.4)             simulator  Shutdown
```

For Android, the name is the serial you pass to `--device`. The plain output does not show iOS UDIDs: use `spana devices --json` to get each device's `id`.

## Web

Web testing uses a local Chromium by default. Install a Playwright browser once (`npx playwright install chromium`), or point `execution.web.executablePath` (or `execution.web.channel` on the `playwright` engine) at an installed browser. The `cdp` engine falls back to a system Chrome when no Playwright Chromium is found. `spana doctor` checks this for you.

Spana always shows `playwright-chromium` as an available web device. The browser engine (`execution.web.engine`: `"playwright"` default, `"cdp"`, `"lightpanda"`, or `"auto"`) is chosen in config, not by device.

## Android

Spana discovers Android devices through `adb` (Android Debug Bridge).

### Prerequisites

- **Android SDK** -- install via [Android Studio](https://developer.android.com/studio) or the command-line tools
- **ADB** -- included in the Android SDK platform tools
- **Java 17+** -- required by UiAutomator2

### Using an emulator

In a single-device run (no `--parallel` / `--workers` / `--devices`), if no device or emulator is connected, spana boots the first AVD from `emulator -list-avds` for you. To start one yourself:

```bash
# List available AVDs
emulator -list-avds

# Start an emulator
emulator -avd Pixel_7_API_34 &

# Verify it appears
adb devices
# emulator-5554   device
```

### Using a physical device

1. Enable **Developer Options** on the device
2. Enable **USB Debugging** in Developer Options
3. Connect via USB and accept the debugging prompt
4. Verify: `adb devices` should show your device serial

### Targeting a specific device

When multiple Android devices are connected:

```bash
# Use the --device flag with the serial from `spana devices`
spana test --platform android --device emulator-5554
```

## iOS

Spana discovers iOS simulators through Xcode's `simctl` (all available simulators, booted or not) and connected physical devices through `xcrun devicectl` (Xcode 15+).

When you do not pass `--device`, spana tries a connected physical device first and falls back to a simulator. It prefers a simulator that already has your app installed (booted first), then any booted simulator, then the first available one, and boots it if needed. Boot a simulator before you target it with `--device`.

### Prerequisites

- **Xcode** -- install from the Mac App Store
- **Xcode Command Line Tools** -- `xcode-select --install`
- **WebDriverAgent** -- spana builds it with `xcodebuild` from the optional `appium-webdriveragent` dependency on first use per simulator

### Booting a simulator

```bash
# List all available simulators
xcrun simctl list devices available

# Boot a simulator
xcrun simctl boot "iPhone 16"

# Or open the Simulator app
open -a Simulator
```

### Targeting a specific simulator

```bash
# Use the UDID from `spana devices --json`
spana test --platform ios --device 7338EC82-D2BD-4722-B148-D009FDA64F6E
```

### Physical iOS devices

Physical iOS devices need `iproxy` (`brew install libimobiledevice`) and a signed WebDriverAgent. Add your team ID so spana can build and sign WDA for the device:

```ts title="spana.config.ts"
export default defineConfig({
  apps: {
    ios: {
      bundleId: "com.example.myapp",
      signing: {
        teamId: "YOUR_TEAM_ID",
        signingIdentity: "Apple Development", // optional, this is the default
      },
    },
  },
});
```

`signing` accepts only `teamId` and `signingIdentity`. Without `signing`, spana expects WebDriverAgent to already be running on the device and only opens the `iproxy` tunnel.

## Multi-device testing

Run the same flows on multiple devices simultaneously. `--device` takes a single ID; use `--devices` (comma-separated) or `--parallel` for more than one:

```bash
# Run on a specific Android and iOS device
spana test --devices emulator-5554,7338EC82-D2BD-4722-B148-D009FDA64F6E

# Auto-discover all devices and run in parallel (cap with --workers <n>)
spana test --platform android,ios --parallel
```

With `--devices`, platforms are inferred from the selected devices when `--platform` is not set. `--devices` cannot be combined with `--device`.

When none of `--device`, `--devices`, `--parallel`, or `--workers` is provided, spana uses one device per platform, chosen as described above.

## Troubleshooting

### Android: "no devices found"

- Check `adb devices` shows your device with state `device` (not `offline` or `unauthorized`)
- Restart ADB: `adb kill-server && adb start-server`
- For emulators, ensure the emulator is fully booted (wait for the home screen)

### iOS: "No iOS simulator or physical device available"

- Check that at least one simulator is available: `xcrun simctl list devices available`
- If none is listed, create one in Xcode (Settings > Platforms / Devices and Simulators)
- To skip the boot wait, boot one first: `xcrun simctl boot "iPhone 16"`

### iOS: WebDriverAgent build fails

- Check that `appium-webdriveragent` is installed (it is an optional dependency), or place WDA in `drivers/ios/WebDriverAgent/`
- Open `WebDriverAgent.xcodeproj` in Xcode and resolve signing issues
- Ensure your Xcode version matches the simulator runtime
- Try: `xcodebuild -showsdks` to verify available SDKs
