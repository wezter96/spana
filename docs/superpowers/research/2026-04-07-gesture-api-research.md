# Multi-Touch Gesture API Research

**Date:** 2026-04-07
**Goal:** Inform spana's pinch/zoom/multi-touch API design by studying WebdriverIO, Maestro, and maestro-runner.

---

## Framework Comparison Table

| Feature                   | WebdriverIO                                                       | Maestro                                                                                             | maestro-runner                                    |
| ------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| **Pinch (zoom out)**      | `element.pinch({ duration, scale })`                              | Not supported (open feature request [#2169](https://github.com/mobile-dev-inc/Maestro/issues/2169)) | Not supported (inherits Maestro YAML limitations) |
| **Zoom (pinch open)**     | `element.zoom({ duration, scale })`                               | Not supported                                                                                       | Not supported                                     |
| **Arbitrary multi-touch** | `browser.actions([...])` with multiple `action('pointer')` chains | Not supported                                                                                       | Not supported                                     |
| **Swipe**                 | W3C Actions pointer sequence                                      | `swipe:` with direction, start/end %, duration, element selector                                    | Inherits Maestro `swipe:` command                 |
| **Tap**                   | W3C Actions or element `.click()`                                 | `tapOn:` with text/id/coordinate selectors                                                          | Same as Maestro                                   |
| **Double tap**            | W3C Actions                                                       | `doubleTapOn:`                                                                                      | Same as Maestro                                   |
| **Long press**            | W3C Actions                                                       | `longPressOn:`                                                                                      | Same as Maestro                                   |
| **Scroll**                | W3C Actions wheel input                                           | `scroll:` / `scrollUntilVisible:`                                                                   | Same, with enhanced native scroll implementation  |
| **Android driver**        | Appium UiAutomator2 gestures + W3C Actions                        | Custom GRPC protocol to on-device agent                                                             | UIAutomator2, optional DeviceLab WebSocket driver |
| **iOS driver**            | Appium XCUITest `mobile:pinch`                                    | Custom GRPC protocol to on-device agent                                                             | WDA (WebDriverAgent)                              |
| **Web support**           | W3C Actions with `pointerType: 'touch'` (browser-dependent)       | `--platform web` via CDP (no gesture support documented)                                            | `--platform web` via CDP (basic, no gestures)     |
| **API style**             | Programmatic (JS/TS chaining)                                     | Declarative YAML                                                                                    | Declarative YAML (Maestro-compatible)             |

---

## 1. WebdriverIO

### API Surface

WebdriverIO offers **three layers** of gesture APIs:

#### Layer 1: High-level element methods (recommended for mobile)

```ts
// Pinch (zoom out) -- element-scoped
await element.pinch({ duration: 1500, scale: 0.5 });

// Zoom (pinch open) -- element-scoped
await element.zoom({ duration: 1500, scale: 0.9 });
```

#### Layer 2: W3C Actions API (low-level, cross-platform)

```ts
// Pinch zoom with two pointers
await browser.actions([
  browser.action("pointer").move(500, 500).down().move(250, 250).up(),
  browser.action("pointer").move(500, 500).down().move(750, 750).up(),
]);

// Single pointer with touch type
browser.action("pointer", {
  parameters: { pointerType: "touch" }, // 'mouse' | 'pen' | 'touch'
});
```

#### Layer 3: Deprecated `touchAction` / `multiTouchAction` (legacy, removed soon)

No longer recommended. Was the old Appium-specific API.

### Parameter Design

**`pinch()` / `zoom()`:**
| Parameter | Type | Default | Range | Notes |
|---|---|---|---|---|
| `duration` | `number` (ms) | 1500 | 500-10000 | Speed of gesture |
| `scale` | `number` (float) | — | 0.0-1.0 | Percentage of element/screen size |

**W3C Actions `action('pointer')`:**

- `move(x, y)` or `move({ x, y, duration, origin })` -- origin can be `'viewport'`, `'pointer'`, or element
- `down(button)` / `up(button)` -- button: `'left'` | `'middle'` | `'right'`
- `pause(ms)` -- timing control between actions

### Driver-Level Implementation

**Android (UiAutomator2):**

- `pinch()` maps to `mobile: pinchCloseGesture` -- parameters: `elementId`, `percent` (0..1), `speed` (px/sec, default `2500 * displayDensity`)
- `zoom()` maps to `mobile: pinchOpenGesture` -- same parameters
- Fallback: W3C Actions with two touch pointers moving in opposite directions

**iOS (XCUITest / WDA):**

- Both `pinch()` and `zoom()` map to `mobile: pinch`
- Parameters: `scale` (float; <1 = pinch close, >1 = pinch open), `velocity` (scale factor/sec), optional `element`
- iOS uses a single command with scale determining direction (unlike Android's separate open/close commands)

### Web Support

- W3C Actions with `pointerType: 'touch'` works in browser contexts
- Support varies by browser; progress tracked at wpt.fyi
- WebdriverIO docs recommend using Appium-specific gesture commands for mobile rather than W3C Actions when possible

---

## 2. Maestro

### API Surface

Maestro's gesture support is **limited to single-touch interactions**:

```yaml
# Supported gestures
- tapOn: "element text"
- doubleTapOn: "element text"
- longPressOn: "element text"
- swipe:
    direction: LEFT # LEFT | RIGHT | UP | DOWN
- swipe:
    start: "90%, 50%" # percentage-based coordinates
    end: "10%, 50%"
    duration: 400 # ms, default 400
- scroll # simple upward swipe from center
- scrollUntilVisible:
    element: "target text"
    direction: DOWN
```

**No pinch, zoom, or multi-touch support exists.** There is an open feature request ([#2169](https://github.com/mobile-dev-inc/Maestro/issues/2169)) proposing a single-finger pinch workaround: double-tap-and-drag, which both Android and iOS support as an accessibility gesture. The proposed YAML would look something like:

```yaml
# Proposed (not yet implemented)
- pinch:
    direction: IN # or OUT
    duration: 500
```

### Parameter Design (swipe, the most complex gesture)

| Parameter               | Type                    | Notes                                   |
| ----------------------- | ----------------------- | --------------------------------------- |
| `direction`             | `LEFT\|RIGHT\|UP\|DOWN` | Uses predefined start/end percentages   |
| `start`                 | `"x%, y%"`              | Percentage of screen dimensions         |
| `end`                   | `"x%, y%"`              | Percentage of screen dimensions         |
| `from`                  | element selector        | Swipe starts from element center        |
| `duration`              | `number` (ms)           | Default 400ms                           |
| `waitToSettleTimeoutMs` | `number` (ms)           | Wait for screen to settle after gesture |

### Driver-Level Implementation

Maestro uses its own **custom GRPC protocol** to communicate with an on-device agent (not Appium). This is why adding multi-touch is non-trivial -- the agent protocol would need to support concurrent touch streams.

### Web Support

Maestro supports `--platform web` but gesture commands on web are minimally documented. The web driver uses CDP and focuses on tap/click/type rather than touch gestures.

---

## 3. maestro-runner

### API Surface

maestro-runner is a **Go-based alternative runner** that executes standard Maestro YAML flows. It does **not extend the gesture API** beyond what Maestro defines. Its differentiation is in execution:

- Runs Maestro YAML flows as-is
- Supports UIAutomator2 (Android), WDA (iOS), CDP (web), and Appium drivers
- Optional DeviceLab driver (~2x faster than UIAutomator2)
- No pinch/zoom/multi-touch commands documented

### Driver-Level Implementation

| Driver        | Platform    | Protocol                                             |
| ------------- | ----------- | ---------------------------------------------------- |
| UIAutomator2  | Android     | Direct device connection (default)                   |
| DeviceLab     | Android     | On-device WebSocket (~2x faster)                     |
| WDA           | iOS         | WebDriverAgent (auto-selected with `--platform ios`) |
| Browser (CDP) | Web         | Chrome DevTools Protocol                             |
| Appium        | Android/iOS | Appium 2.x/3.x (for cloud providers)                 |

maestro-runner could theoretically add pinch/zoom via UiAutomator2 gesture extensions or WDA `mobile:pinch`, but it currently does not.

---

## 4. Web Gesture Support Analysis (Playwright)

Since spana's web driver is Playwright-based, web gesture support is relevant.

### Playwright's Current Touch Support

**Built-in `Touchscreen` class** -- limited to `tap(x, y)` only. No multi-touch.

**Manual touch event dispatch** -- Playwright documents how to manually dispatch `TouchEvent`s for pinch/pan:

```ts
// Pinch gesture via dispatchEvent (from Playwright docs)
async function pinch(locator, { deltaX, steps, direction }) {
  const { centerX, centerY } = await locator.evaluate(/* get bounds */);
  // Create two touch points moving toward/away from center
  const touches = [
    { identifier: 0, clientX: centerX - delta, clientY: centerY },
    { identifier: 1, clientX: centerX + delta, clientY: centerY },
  ];
  await locator.dispatchEvent("touchstart", { touches, changedTouches: touches });
  // Animate touch points through steps...
  await locator.dispatchEvent("touchend");
}
```

**CDP `Input.synthesizePinchGesture`** -- Chrome-only, accepts center coordinates and scale factor. Not cross-browser.

### Key Limitation

`dispatchEvent` produces events with `isTrusted: false`. Apps that check `Event.isTrusted` will ignore these. This makes web pinch/zoom testing inherently unreliable compared to native mobile gestures.

---

## Recommended API Design for spana

### Principles (derived from research)

1. **High-level first, low-level escape hatch** -- WebdriverIO's approach of `element.pinch()` / `element.zoom()` with simple parameters is the best UX. The W3C Actions API is powerful but verbose.
2. **Percentage-based coordinates** -- Maestro's `"50%, 50%"` pattern and WebdriverIO's `scale: 0..1` both avoid hardcoded pixel values. This is essential for cross-device reliability.
3. **Unified pinch/zoom with direction** -- iOS uses a single `mobile:pinch` with scale (<1 or >1) to determine direction. This is cleaner than Android's separate pinchOpen/pinchClose. Use a single method with a `direction` parameter.
4. **Element-scoped by default** -- All three frameworks anchor gestures to elements when possible. spana should follow this pattern.

### Proposed API

```ts
// High-level gestures (element-scoped)
await app.pinch("map-element", { scale: 0.5, duration: 1500 }); // zoom out
await app.zoom("map-element", { scale: 2.0, duration: 1500 }); // zoom in

// Or unified:
await app.pinchZoom("map-element", {
  direction: "in", // "in" = zoom in (fingers apart), "out" = zoom out (fingers together)
  scale: 0.75, // magnitude of the gesture (0..1 = percentage of element size)
  duration: 1500, // ms
});

// Low-level escape hatch for arbitrary multi-touch
await app.multiTouch([
  {
    id: 0,
    actions: [
      { type: "move", x: 100, y: 200 },
      { type: "down" },
      { type: "move", x: 50, y: 100 },
      { type: "up" },
    ],
  },
  {
    id: 1,
    actions: [
      { type: "move", x: 100, y: 200 },
      { type: "down" },
      { type: "move", x: 150, y: 300 },
      { type: "up" },
    ],
  },
]);
```

### Proposed Parameters

| Parameter   | Type            | Default    | Notes                                                |
| ----------- | --------------- | ---------- | ---------------------------------------------------- |
| `selector`  | `string`        | (required) | Element to gesture on                                |
| `direction` | `"in" \| "out"` | (required) | Zoom in = fingers apart, zoom out = fingers together |
| `scale`     | `number`        | `0.5`      | 0..1 for magnitude (percentage of element/screen)    |
| `duration`  | `number` (ms)   | `1500`     | Speed of gesture (min 500, max 10000)                |

### Driver-Level Translation

| Platform                   | pinch (zoom out)                                     | zoom (zoom in)                                      |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| **Android (UiAutomator2)** | `mobile: pinchCloseGesture` with `percent` + `speed` | `mobile: pinchOpenGesture` with `percent` + `speed` |
| **Android (direct UIA2)**  | Same as above via spana's existing UIA2 client       | Same                                                |
| **iOS (WDA)**              | `mobile: pinch` with `scale < 1` + `velocity`        | `mobile: pinch` with `scale > 1` + `velocity`       |
| **iOS (Appium XCUITest)**  | Same route via Appium session                        | Same                                                |
| **Web (Playwright)**       | `dispatchEvent` with two touch points converging     | `dispatchEvent` with two touch points diverging     |

### Web Gesture Support: Not Worth Prioritizing

**Recommendation: Do not invest in web pinch/zoom for the initial implementation.**

Reasons:

1. Playwright's touch support is limited to `tap()` -- multi-touch requires manual `dispatchEvent` which produces `isTrusted: false` events
2. CDP `Input.synthesizePinchGesture` is Chrome-only
3. Real-world web apps rarely need pinch/zoom testing -- those that do (maps, image viewers) typically have button-based zoom controls that are easier to test
4. WebdriverIO's own documentation recommends using Appium-specific gesture commands over W3C Actions for mobile gestures
5. If needed later, the `dispatchEvent` approach can be added as an opt-in, browser-only feature with appropriate caveats

### Implementation Priority

1. **Phase 1:** `pinch()` and `zoom()` for Android (UiAutomator2 gesture extensions) and iOS (WDA `mobile:pinch`)
2. **Phase 2:** Low-level `multiTouch()` escape hatch using W3C Actions for both platforms
3. **Phase 3 (optional):** Web gesture support via `dispatchEvent` if demand materializes

---

## Sources

- [WebdriverIO pinch API](https://webdriver.io/docs/api/mobile/pinch/)
- [WebdriverIO zoom API](https://webdriver.io/docs/api/mobile/zoom/) (same parameter design as pinch)
- [WebdriverIO action API](https://webdriver.io/docs/api/browser/action/) (W3C Actions, pointer/key/wheel)
- [WebdriverIO actions API](https://webdriver.io/docs/api/browser/actions/) (multi-pointer pinch zoom example)
- [WebdriverIO touchAction (deprecated)](https://webdriver.io/docs/api/browser/touchAction/)
- [Appium UiAutomator2 gesture commands](https://github.com/appium/appium-uiautomator2-driver/blob/master/docs/android-mobile-gestures.md)
- [Appium XCUITest gesture commands](https://appium.github.io/appium-xcuitest-driver/latest/guides/gestures/)
- [Maestro pinch feature request #2169](https://github.com/mobile-dev-inc/Maestro/issues/2169)
- [Maestro swipe command](https://docs.maestro.dev/api-reference/commands/swipe)
- [Maestro documentation](https://docs.maestro.dev)
- [maestro-runner GitHub](https://github.com/devicelab-dev/maestro-runner)
- [Playwright touch events](https://playwright.dev/docs/touch-events)
- [Playwright Touchscreen class](https://playwright.dev/docs/api/class-touchscreen)
- [W3C Actions - Appium](https://appium.github.io/appium.io/docs/en/commands/interactions/actions/)
