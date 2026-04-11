# Appium driver endpoint conventions

This doc lists the wire-protocol endpoints the Appium drivers
(`packages/spana/src/drivers/appium/`) may use, and which to avoid. It exists
because cloud Appium providers (BrowserStack, Sauce Labs, etc.) pin older /
differently-built Appium driver versions than a fresh local install, and
Appium's proprietary extension endpoints drift across versions and providers.
The W3C-standard endpoints are stable across everyone who implements the spec.

**Rule of thumb:** if a W3C-standard endpoint exists, use it. Reach for an
Appium extension only when nothing in the W3C spec covers the capability.

## ✅ Preferred — W3C standard, stable across providers

| Endpoint                                                    | Spana method                                                                                          | Notes                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `POST /session/{id}/actions`                                | `tapAtCoordinate`, `doubleTapAtCoordinate`, `longPressAtCoordinate`, `swipe`, `inputText`, `pressKey` | W3C pointer + key actions. Works identically on WDA, UiAutomator2, Playwright.                      |
| `POST /session/{id}/execute/sync`                           | Anything dispatched as a `mobile:` command                                                            | Preferred over `/appium/execute_mobile/*`. See allow-list below for allowed `mobile:` script names. |
| `GET /session/{id}/source`                                  | `dumpHierarchy`                                                                                       | Page source in platform-native XML.                                                                 |
| `GET /session/{id}/screenshot`                              | `takeScreenshot`                                                                                      | Base64 PNG.                                                                                         |
| `GET /session/{id}/window/rect`                             | screen size                                                                                           | Fallback when provider lacks `getWindowSize`.                                                       |
| `POST /session/{id}` + `DELETE /session/{id}`               | `createSession` / `deleteSession`                                                                     | Standard session lifecycle.                                                                         |
| `POST /session/{id}/context` + `GET /session/{id}/contexts` | WebView context switching                                                                             | Used by hybrid-app flows.                                                                           |

## ⚠️ Avoid — Appium-proprietary, diverges across versions/providers

These endpoints worked on some providers and not others. They bit us on
BrowserStack during the initial cloud bring-up. Don't reintroduce them
without a fallback.

| Endpoint                                         | Why it's bad                                                                                                                                                | Use instead                                                                                                                                             |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/appium/gestures/click`                         | UiAutomator2-specific Appium extension; returns 404 on some cloud providers.                                                                                | `POST /actions` with a W3C pointer sequence (`pointerMove` → `pointerDown` → `pointerUp`).                                                              |
| `/appium/gestures/double_click`                  | Same problem.                                                                                                                                               | Two W3C pointer sequences with a short pause between them.                                                                                              |
| `/appium/gestures/long_click`                    | Same problem.                                                                                                                                               | W3C pointer sequence with a `pause` action between down and up.                                                                                         |
| `/appium/execute_mobile/clearApp`                | Non-standard path; 404 on BrowserStack.                                                                                                                     | `POST /execute/sync` with `{ script: "mobile: clearApp", args: [{ appId }] }` (Android) or `{ bundleId }` (iOS).                                        |
| `POST /session/{id}/url` (for native deep links) | Routes through the default browser on iOS WDA and through unreliable intent handling on Android Appium; cloud providers often block it for native contexts. | Android: `mobile: deepLink` via `/execute/sync`. iOS: UI-level navigation through the app's nav menu (WDA's `openUrl` opens Safari instead of the app). |

## 🔧 Allowed Appium extensions — no W3C equivalent

Some Appium-namespaced endpoints have no W3C counterpart. These are allowed,
but wrap them in a try/fallback where possible and document the minimum
driver version required.

| Endpoint                                         | Used for                                            | Notes                                                                                                                           |
| ------------------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /session/{id}/appium/device/activate_app`  | Bring app to foreground                             | Stable across Appium 1.x + 2.x.                                                                                                 |
| `POST /session/{id}/appium/device/terminate_app` | Kill app process                                    | Stable across Appium 1.x + 2.x.                                                                                                 |
| `POST /session/{id}/appium/device/hide_keyboard` | Keyboard dismissal on Android                       | On iOS, WDA can't always dismiss React Native keyboards; prefer tapping an explicit Dismiss button in the app.                  |
| `POST /session/{id}/appium/device/press_keycode` | Android hardware keycodes                           | No W3C equivalent.                                                                                                              |
| `POST /session/{id}/appium/settings`             | `snapshotMaxDepth`, `shouldWaitForQuiescence`, etc. | This path is exposed natively by WebDriverAgent, not just Appium — the `/appium/` prefix is historical. Safe on direct-WDA too. |

## 🧩 Allowed `mobile:` commands via `/execute/sync`

| Script             | Platform                      | Args                  | Notes                                                                                                                    |
| ------------------ | ----------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `mobile: clearApp` | Android (UiAutomator2 driver) | `[{ appId }]`         | Requires appium-uiautomator2-driver ≥ 2.x.                                                                               |
| `mobile: clearApp` | iOS (XCUITest driver)         | `[{ bundleId }]`      | Requires appium-xcuitest-driver ≥ 4.17. Fall back to terminate-only if unavailable (BrowserStack currently ships older). |
| `mobile: deepLink` | Android                       | `[{ url, package? }]` | BrowserStack requires `package`. Thread bundleId through the driver factory.                                             |

If you add another `mobile:` command, add it here and document both the args
shape and the minimum driver version.

## Adding a new driver capability

1. Look up whether a W3C-standard endpoint already covers the capability.
2. If yes, use it. Add a row to the "Preferred" table above.
3. If no, check the Appium docs for a `mobile:` command on the relevant driver.
   - If it exists and is stable, use `/execute/sync` with a `mobile:` script
     and add it to the `mobile:` allow-list above.
   - Wrap it in a try/fallback with a reasonable degradation path where
     possible (e.g. `clearApp` falls back to terminate-only).
4. If there's no `mobile:` command either, an `/appium/...` endpoint may be
   necessary — add it to the "Allowed Appium extensions" table above with a
   note about minimum supported version and any known provider gaps.

## Why this matters in practice

The whole spana cloud bring-up in April 2026 was debugging variants of
"the endpoint we use locally doesn't exist on BrowserStack." Every single
failure traced back to an Appium-proprietary extension. W3C-standard
endpoints just worked. The direct-WDA / direct-UiAutomator2 drivers also
benefit because W3C endpoints tend to be the stable subset those servers
support natively too.
