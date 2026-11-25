---
title: Architecture Overview
description: High-level architecture, layered design, and element resolution flow.
---

spana uses a layered architecture where all logic lives in TypeScript on the host machine. Platform drivers are thin clients (HTTP for UiAutomator2/WebDriverAgent/Appium, CDP or Playwright for browsers and desktop webviews) with no embedded selector logic.

## High-level architecture

```mermaid
graph TD
    A[flow files .flow.ts] --> B[CLI: spana test]
    B --> C[TestRunner / runner.ts]
    C --> D[PlatformOrchestrator]
    D --> E1[Web: Playwright, direct CDP, or Lightpanda]
    D --> E2[Android: UiAutomator2]
    D --> E3[iOS: WebDriverAgent]
    D --> E4[Electron / Electrobun]
    E1 --> F[Reporter]
    E2 --> F
    E3 --> F
    E4 --> F
    F --> G1[console]
    F --> G2[json]
    F --> G3[junit]
    F --> G4[html]
    F --> G5[allure / github]
```

By default, platforms run one after another so each runtime has exclusive access to its simulator, emulator, or browser. They run concurrently when you pass `--parallel`, `--workers`, or `--devices`, or set `parallelPlatforms: true` in config. Within a platform, flows run serially on one worker, or are pulled from a shared queue when the platform has several workers (see [Parallel execution](#parallel-execution)). Results are collected and passed to the configured reporter(s).

## Layered architecture

```mermaid
graph TD
    subgraph User API
        A1["flow() — define test"]
        A2["app — launch, tap, swipe, type"]
        A3["expect — toBeVisible, toHaveText, toBeHidden"]
    end

    subgraph Smart Layer [Smart Layer — src/smart/]
        B1[coordinator.ts — action dispatch]
        B2[auto-wait.ts — poll until element appears]
        B3[element-matcher.ts — client-side tree search + centerOf]
    end

    subgraph Raw Driver [Raw Driver — src/drivers/raw-driver.ts]
        C[RawDriverService interface]
        C1[tapAtCoordinate / swipe / inputText]
        C2[dumpHierarchy — returns raw XML or JSON]
        C3[launchApp / stopApp / takeScreenshot]
    end

    subgraph Companion Drivers
        D1[playwright.ts / cdp-browser.ts — Playwright or direct CDP]
        D2[uiautomator2/driver.ts — HTTP to APK server]
        D3[wda/driver.ts — HTTP to XCTest runner]
    end

    subgraph Devices
        E1[Browser / Chromium]
        E2[Android emulator or device]
        E3[iOS simulator or device]
    end

    A2 --> B1
    A3 --> B1
    B1 --> B2
    B2 --> C2
    B2 --> B3
    B3 --> B1
    B1 --> C1
    C --> D1
    C --> D2
    C --> D3
    D1 --> E1
    D2 --> E2
    D3 --> E3
```

The Smart Layer resolves selectors to elements, derives center coordinates, then calls the thin `RawDriver` interface. The coordinate-level `RawDriver` methods know nothing about selectors. When a driver exposes an optional DOM channel (web drivers, or the in-app `spana-bridge` for webviews), the Smart Layer can resolve and act on selectors inside the page instead (`smart/channel-resolver.ts`).

## Element resolution flow

How `app.tap({ testID: "login" })` executes end-to-end:

```mermaid
sequenceDiagram
    participant Flow as flow.ts
    participant Coord as coordinator.ts
    participant Wait as auto-wait.ts
    participant Driver as RawDriverService
    participant Parser as platform parser
    participant Companion as companion server

    Flow->>Coord: tap({ testID: "login" })
    Coord->>Wait: waitForElement(selector)
    loop poll until found or timeout
        Wait->>Driver: dumpHierarchy()
        Driver->>Companion: HTTP GET /session/:id/source
        Companion-->>Driver: raw XML / JSON string
        Driver-->>Wait: RawHierarchy
        Wait->>Parser: parse(raw) -> Element tree
        Wait->>Wait: findElement(tree, { testID: "login" })
    end
    Wait-->>Coord: Element (with bounds)
    Coord->>Coord: centerOf(element) -> {x, y}
    Coord->>Driver: tapAtCoordinate(x, y)
    Driver->>Companion: HTTP POST /appium/gestures/click (Android) or /wda/tap (iOS)
```

The diagram shows the native (Android/iOS) path. The parser is platform-specific (XML for Android/iOS, JSON for web) but always produces the same unified `Element` tree shape. On the native path, all matching logic runs client-side in TypeScript.

## Parallel execution

```mermaid
graph TD
    subgraph Flow Queue [Shared flow queue]
        Q1[flow 1]
        Q2[flow 2]
        Q3[flow 3]
        Q4[flow 4]
        Q5[flow 5]
    end

    subgraph Workers
        W1[Worker A — Pixel 7]
        W2[Worker B — Galaxy S23]
        W3[Worker C — iPhone 15 sim]
    end

    Q1 --> W1
    Q2 --> W2
    Q3 --> W3
    Q4 --> W1
    Q5 --> W2

    W1 --> R[Aggregated Results]
    W2 --> R
    W3 --> R
```

Workers share a single atomic index into the flow array. Because Bun is single-threaded, the increment is naturally safe with no mutex. A faster device finishes sooner and picks up the next flow immediately, draining the queue at the speed of the fastest workers. When a previous run recorded flow durations (`spana-output/.spana/last-run.json`), the queue is ordered longest-first.

For web, `--workers <n>` creates `n` isolated browser contexts spread across `ceil(n / execution.web.maxContextsPerBrowser)` browser processes (default: 1 context per browser for the `cdp` engine, 2 for `playwright`). Android and iOS get one worker per discovered device.

- `parallel.ts` — `runParallel()` launches all workers with `Promise.all`, each looping over the queue until exhausted.
- `orchestrator.ts` — `orchestrate()` runs each platform (single worker or `runParallel()` pool). Platforms run serially unless `parallelPlatforms` is enabled.
- `runtime/local.ts` — `buildWebRuntimePool()` builds the web worker pool.

## Agent workflow

```mermaid
graph LR
    A[Agent] -->|spana selectors --platform android| B[Discover elements\nJSON list with suggestedSelector]
    B -->|generate flow code| C[Write flow.ts]
    C -->|spana validate| D[Validate schema\nno device needed]
    D -->|spana test --reporter json| E[Execute on device]
    E -->|read JSON errors| F[Fix and retry]
    F --> C
```

`session.ts` backs `spana hierarchy` and `spana selectors`. `Session.selectors()` dumps the element tree, flattens it, and returns only visible elements with a `testID`, `accessibilityLabel`, or `text` — each annotated with the best-priority selector to use in a flow file.

## Monorepo structure

```mermaid
graph TD
    Root[spana/]

    Root --> Packages[packages/]
    Root --> Apps[apps/]

    Packages --> PProvPkg[spana/ — core library and CLI]
    Packages --> Bridge[spana-bridge/ — in-app DOM bridge]
    Packages --> NativePkg[spana-native/ — Rust native accelerator]
    Packages --> Config[config/ — shared TS/lint config]
    Packages --> Env[env/ — environment helpers]
    Packages --> UI[ui/ — shared UI components]

    Apps --> Web[web/ — web app under test]
    Apps --> Native[native/ — React Native app under test]
    Apps --> TUI[tui/ — terminal UI]
    Apps --> Studio[studio/ — Spana Studio UI]
    Apps --> Docs[docs/]

    PProvPkg --> Src[src/]
    Src --> API[api/ — flow, app, expect user API]
    Src --> Core[core/ — engine, orchestrator, parallel, runner]
    Src --> Smart[smart/ — coordinator, auto-wait, element-matcher]
    Src --> Drivers[drivers/ — raw-driver interface + platform impls]
    Src --> Channels[channels/ — CDP, WebKit inspector, bridge DOM channels]
    Src --> Runtime[runtime/ — local, Appium, web engine selection]
    Src --> Cloud[cloud/ — BrowserStack, Sauce Labs, custom providers]
    Src --> Agent[agent/ — session.ts for agent/CLI inspection]
    Src --> CLI2[cli/ — CLI entry point]
    Src --> Device[device/ — ADB, simctl device discovery]
    Src --> Report[report/ — console, json, junit, html, allure, github reporters]
    Src --> Schemas[schemas/ — Element, Selector, DeviceInfo types]
```
