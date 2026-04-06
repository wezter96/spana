---
title: Device Setup
description: Set up Android emulators, iOS simulators, and physical devices for testing.
---

Spana auto-discovers available devices for each platform. This guide covers how to set up and verify your devices before running tests.

## Checking available devices

```bash
spana devices
```

This lists all discovered devices across your configured platforms:

```
Platform   ID                                     Name                        Type
web        playwright-chromium                     Chromium (Playwright)       browser
android    emulator-5554                           emulator-5554               emulator
ios        7338EC82-D2BD-4722-B148-D009FDA64F6E    iPhone 16 (iOS 18.4)        simulator
```

## Web (Playwright)

Web testing works out of the box -- Playwright manages its own Chromium browser. No setup required.

Spana always shows `playwright-chromium` as an available web device.

## Android

Spana discovers Android devices through `adb` (Android Debug Bridge).

### Prerequisites

- **Android SDK** -- install via [Android Studio](https://developer.android.com/studio) or the command-line tools
- **ADB** -- included in the Android SDK platform tools
- **Java 17+** -- required by UiAutomator2

### Using an emulator

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

Spana discovers booted iOS simulators through Xcode's `simctl`.

### Prerequisites

- **Xcode** -- install from the Mac App Store
- **Xcode Command Line Tools** -- `xcode-select --install`
- **A booted simulator** -- spana only discovers simulators that are already running

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
# Use the UDID from `spana devices`
spana test --platform ios --device 7338EC82-D2BD-4722-B148-D009FDA64F6E
```

### Physical iOS devices

Physical iOS device testing requires additional signing configuration in your config:

```ts title="spana.config.ts"
export default defineConfig({
  apps: {
    ios: {
      bundleId: "com.example.myapp",
      signing: {
        teamId: "YOUR_TEAM_ID",
        signingId: "Apple Development",
        provisioningProfile: "path/to/profile.mobileprovision",
      },
    },
  },
});
```

## Multi-device testing

Run the same flows on multiple devices simultaneously:

```bash
# Run on a specific Android and iOS device
spana test \
  --platform android,ios \
  --device emulator-5554 \
  --device 7338EC82-D2BD-4722-B148-D009FDA64F6E
```

When no `--device` flag is provided, spana uses the first available device for each platform.

## Troubleshooting

### Android: "no devices found"

- Check `adb devices` shows your device with state `device` (not `offline` or `unauthorized`)
- Restart ADB: `adb kill-server && adb start-server`
- For emulators, ensure the emulator is fully booted (wait for the home screen)

### iOS: "no simulators found"

- Spana only discovers **booted** simulators -- make sure one is running
- Check: `xcrun simctl list devices booted`
- If empty, boot one: `xcrun simctl boot "iPhone 16"`

### iOS: WebDriverAgent build fails

- Open `WebDriverAgent.xcodeproj` in Xcode and resolve signing issues
- Ensure your Xcode version matches the simulator runtime
- Try: `xcodebuild -showsdks` to verify available SDKs
