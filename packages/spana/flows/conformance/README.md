# Driver conformance flows

These flows exercise the `RawDriverService` interface end-to-end with the
smallest possible surface. Each flow targets **one driver method** (or a
tight group of related methods) so that a failure points directly at the
responsible driver method.

The full set must pass identically on all `RawDriverService`
implementations:

- `wda/` direct driver (iOS simulator)
- `uiautomator2/` direct driver (Android emulator)
- `appium/android.ts` via a local or remote Appium server
- `appium/ios.ts` via a local or remote Appium server

This is what "contract test" means in spana: running the same flows
through different driver implementations and asserting identical
observable behavior.

## Running locally

Direct drivers (fast dev loop):

```bash
# iOS sim
spana test --driver local --platform ios --config packages/spana/conformance.config.ts

# Android emulator
spana test --driver local --platform android --config packages/spana/conformance.config.ts
```

Local Appium (parity with cloud path):

```bash
# Terminal 1
appium --base-path /

# Terminal 2
export SPANA_APPIUM_URL=http://localhost:4723
spana test --driver appium --platform android --config packages/spana/conformance.config.ts
```

Or use the opt-in auto-start:

```bash
spana test --driver appium --appium-auto-start --platform android \
  --config packages/spana/conformance.config.ts
```

## CI

`.github/workflows/driver-conformance.yml` runs the full matrix on every PR
touching `packages/spana/src/drivers/**` or `packages/spana/flows/**`. See
that file for the exact invocation.

## Adding a new conformance flow

1. Pick the driver method you want to cover. If it's already covered by an
   existing flow, extend that flow rather than adding a new one.
2. Create a new `<method>.flow.ts` file in this directory. Name it after
   the driver method, not after the user-facing behavior.
3. Keep the flow under 30 seconds. Conformance is about proving the
   method works, not stress-testing it.
4. Do not depend on state from a previous flow. Each conformance flow must
   start with `clearState: true` on Android (or the iOS equivalent).
5. Update the "Coverage" section in this README when you add a method.

## Coverage

| Driver method                            | Flow file                       |
| ---------------------------------------- | ------------------------------- |
| `launchApp` / `clearAppState`            | `app-lifecycle.flow.ts`         |
| `launchApp` with `deepLink`              | `deep-link.flow.ts`             |
| `dumpHierarchy` (via expect)             | covered by every flow           |
| `tapAtCoordinate` (via selector → coord) | `tap.flow.ts`                   |
| `doubleTapAtCoordinate`                  | `double-tap.flow.ts`            |
| `longPressAtCoordinate`                  | `long-press.flow.ts`            |
| `swipe` / `scroll`                       | `scroll.flow.ts`                |
| `inputText` / `pressKey`                 | `input-text.flow.ts`            |
| `hideKeyboard` (iOS: via dismiss button) | covered by `input-text.flow.ts` |
| `takeScreenshot`                         | `screenshot.flow.ts`            |
| `getDeviceInfo`                          | covered by runtime setup        |
| `openLink`                               | `open-link.flow.ts`             |
| `back`                                   | `back.flow.ts`                  |

Not covered at the conformance layer:

- Web-only methods (`mockNetwork`, `getHAR`, `downloadFile`, etc.) — those
  have their own Playwright-focused tests in `src/drivers/playwright.test.ts`.
- Optional multi-touch methods (`pinch`, `zoom`, `multiTouch`) — these vary
  too much across drivers to have a single contract test; cover them in
  driver-specific unit tests instead.
- `evaluate` — WebView-specific, covered by the web driver tests.
