# Running the Appium driver locally

The Appium driver (`src/drivers/appium/`) is the same code that talks to
BrowserStack, Sauce Labs, and other cloud providers. Running it against a
**local** Appium server is the fastest way to iterate on Appium-specific bugs
without burning cloud minutes, and it's how the driver conformance CI job
catches cloud-path regressions before they ship.

This doc covers both the manual setup and the opt-in auto-start flow.

## Prerequisites

Install Appium and the drivers for the platforms you want to test:

```bash
# Appium server
npm install -g appium

# Platform drivers
appium driver install xcuitest       # iOS (requires Xcode)
appium driver install uiautomator2   # Android (requires Android SDK + emulator)
```

You still need the underlying platform toolchains:

- **iOS**: Xcode, a booted simulator, and WebDriverAgent built at least once.
  Appium's XCUITest driver manages WDA for you after the first build.
- **Android**: Android SDK, `adb` on your PATH, and a running emulator
  (or connected device). Appium's UiAutomator2 driver handles the UA2
  server install.

## Option 1 — Manual start (recommended for debugging)

```bash
# Terminal 1: start Appium
appium --base-path /

# Terminal 2: point spana at it and run a test
export SPANA_APPIUM_URL=http://localhost:4723
bun run spana test --driver appium --platform android --caps-json '{
  "appium:deviceName": "emulator-5554",
  "appium:platformVersion": "13.0",
  "appium:app": "/absolute/path/to/your/app-release.apk"
}'
```

`SPANA_APPIUM_URL` is equivalent to passing `--appium-url` on every command.
Once set, you can iterate quickly: edit driver code → rebuild spana → rerun.

You'll see the Appium server log every HTTP call that spana makes. This is
invaluable when debugging — you can see exactly which endpoint spana hit and
what Appium returned.

## Option 2 — Auto-start from spana (opt-in)

For quick ad-hoc runs without juggling two terminals, spana can spawn a local
Appium server, wait for it to become ready, and tear it down when the test
run finishes. You opt in explicitly — spana never starts background processes
without you asking.

```bash
# CLI flag
bun run spana test --driver appium --appium-auto-start --platform android

# Or in spana.config.ts
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      autoStart: true, // spawn `appium` as a subprocess
      // serverUrl omitted — will be assigned to the auto-started server
    },
  },
  ...
});
```

When `autoStart` is on, spana:

1. Runs `appium` from your PATH on a random free port.
2. Waits up to 30 seconds for `GET /status` to return 200.
3. Injects `http://localhost:<port>` as the appium URL for the run.
4. On exit (including Ctrl-C / test failure), sends SIGTERM to the server,
   waits for it to shut down, then exits.

If `appium` isn't on your PATH, auto-start fails with a clear error pointing
at the install instructions above. It does **not** fall back to a global
install or anything surprising.

## Platform capabilities

Local Appium needs a `deviceName` that matches a running emulator/simulator,
plus the path to an installable artifact (APK for Android, `.app` bundle or
`.ipa` for iOS). Add them via `spana.config.ts`:

```ts
export default defineConfig({
  execution: {
    mode: "appium",
    appium: {
      serverUrl: process.env.SPANA_APPIUM_URL,
      platformCapabilities: {
        android: {
          "appium:deviceName": process.env.ANDROID_EMULATOR ?? "emulator-5554",
          "appium:platformVersion": "13.0",
          "appium:app": "/absolute/path/to/app-release.apk",
        },
        ios: {
          "appium:deviceName": "iPhone 15",
          "appium:platformVersion": "17.0",
          "appium:app": "/absolute/path/to/MyApp.app",
          "appium:useNewWDA": false, // reuse the built WDA to save time
        },
      },
    },
  },
});
```

Unlike the BrowserStack path, `appium:app` is a local filesystem path here —
no upload step, no `bs://` URL.

## Why bother?

Three reasons:

1. **Catch cloud-path bugs locally.** Every issue we fixed during the
   BrowserStack bring-up — `gestures/click` returning 404,
   `execute_mobile/clearApp` not existing, deep links going through Safari —
   could have been caught days earlier if the Appium driver were routinely
   exercised on a local Appium server. The endpoints Appium exposes locally
   are the same endpoints BrowserStack's Appium hub exposes (modulo version
   differences).

2. **Cheaper iteration.** No cloud session setup, no video encoding, no
   minute budget. A full `spana test` run locally against Appium takes a
   fraction of what the same run costs on BrowserStack.

3. **Driver conformance.** The conformance CI job
   (`.github/workflows/driver-conformance.yml`) runs the same behavioral
   contract against both the direct driver and the Appium driver. If they
   diverge, the job fails before a PR merges. See
   `src/drivers/__contract__/` for the test suite.

## Known version caveats

Appium drivers evolve — a `mobile:` command that exists locally may not exist
on BrowserStack, and vice versa. The most notable gap we've seen:

- `mobile: clearApp` requires `appium-xcuitest-driver ≥ 4.17` and
  `appium-uiautomator2-driver ≥ 2.x`. BrowserStack ships older. Spana's iOS
  driver falls back to terminate-only with a warning when the command is
  missing. See `docs/internals/appium-endpoints.md` for the full list of
  allowed commands and the minimum driver versions each one requires.

If you hit a version gap running locally, check which Appium driver versions
you have installed:

```bash
appium driver list --installed
```

And pin them to match the provider you care about if you're trying to
reproduce a cloud-only bug.
