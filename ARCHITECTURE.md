# prov Architecture

## 1. High-Level Architecture

```mermaid
graph TD
    A[flow files .flow.ts] --> B[CLI: prov test]
    B --> C[TestRunner / runner.ts]
    C --> D[PlatformOrchestrator]
    D -->|parallel platforms| E1[Web: Playwright CDP]
    D -->|parallel platforms| E2[Android: UiAutomator2]
    D -->|parallel platforms| E3[iOS: WebDriverAgent]
    E1 --> F[Reporter]
    E2 --> F
    E3 --> F
    F --> G1[console]
    F --> G2[json]
    F --> G3[junit]
```

Platforms run in parallel. Within each platform, flows run serially. Results are collected and handed to the configured reporter.

---

## 2. Layered Architecture

```mermaid
graph TD
    subgraph User API
        A1["flow() — define test"]
        A2["app — launch, tap, swipe, type"]
        A3["expect — assertVisible, assertText, assertHidden"]
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
        D1[playwright.ts — CDP via Playwright]
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

The Smart Layer never sees raw coordinates. It resolves selectors to elements, then derives coordinates before calling the thin RawDriver interface. The RawDriver knows nothing about selectors.

---

## 3. Element Resolution Flow

How `app.tap({ testID: "login" })` executes:

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
        Driver->>Companion: HTTP GET /source
        Companion-->>Driver: raw XML / JSON string
        Driver-->>Wait: RawHierarchy
        Wait->>Parser: parse(raw) -> Element tree
        Wait->>Wait: findElement(tree, { testID: "login" })
    end
    Wait-->>Coord: Element (with bounds)
    Coord->>Coord: centerOf(element) -> {x, y}
    Coord->>Driver: tapAtCoordinate(x, y)
    Driver->>Companion: HTTP POST /touch/perform
```

The parser is platform-specific (XML for Android/iOS, JSON for web) but always produces the same unified `Element` tree shape. All matching logic runs client-side in TypeScript.

---

## 4. Driver Architecture

```mermaid
graph LR
    subgraph CLI process [CLI process — Bun/TS]
        RD[RawDriverService]
    end

    subgraph Android
        UA2[UiAutomator2 APK server\nport 6790 on device\nADB-forwarded to host]
    end

    subgraph iOS
        WDA[WebDriverAgent XCTest\nport 8100+ on simulator\niproxy-forwarded to host]
    end

    subgraph Web
        PW[Playwright / Chromium\nCDP in-process]
    end

    RD -- HTTP --> UA2
    RD -- HTTP --> WDA
    RD -. CDP .-> PW
```

The Android and iOS drivers are pure HTTP clients — no native bindings. The companion servers (UiAutomator2 APK and WDA XCTest bundle) are installed and port-forwarded during setup before the test run begins. The web driver uses Playwright's CDP API in-process.

---

## 5. Parallel Execution

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

Workers share a single atomic index into the flow array (`nextFlowIndex++`). Because Bun/Node is single-threaded, the increment is naturally safe with no mutex. A faster device finishes sooner and picks up the next flow immediately, so the queue drains at the speed of the fastest workers.

`parallel.ts` — `runParallel()` launches all workers with `Promise.all`, each looping over the queue until exhausted.

`orchestrator.ts` — `orchestrate()` is the simpler variant that runs one worker per platform with all flows for that platform in series, platforms in parallel.

---

## 6. Agent Workflow

How an AI agent uses prov to discover, write, and validate flows:

```mermaid
graph LR
    A[Agent] -->|prov selectors --platform android| B[Discover elements\nJSON list with suggestedSelector]
    B -->|generate flow code| C[Write flow.ts]
    C -->|prov validate| D[Validate schema\nno device needed]
    D -->|prov test --reporter json| E[Execute on device]
    E -->|read JSON errors| F[Fix and retry]
    F --> C
```

`session.ts` backs the `prov hierarchy` and `prov selectors` commands. `Session.selectors()` dumps the element tree, flattens it, and returns only visible elements that have a testID, accessibilityLabel, or text — each annotated with the best-priority selector to use in a flow file.

---

## 7. Monorepo Structure

```mermaid
graph TD
    Root[prov/]

    Root --> Packages[packages/]
    Root --> Apps[apps/]

    Packages --> PProvPkg[prov/ — core library and CLI]
    Packages --> Config[config/ — shared TS/lint config]
    Packages --> Env[env/ — environment helpers]
    Packages --> UI[ui/ — shared UI components]

    Apps --> Web[web/ — web app under test]
    Apps --> Native[native/ — React Native app under test]
    Apps --> TUI[tui/ — terminal UI]
    Apps --> Docs[docs/]

    PProvPkg --> Src[src/]
    Src --> API[api/ — flow, app, expect user API]
    Src --> Core[core/ — engine, orchestrator, parallel, runner]
    Src --> Smart[smart/ — coordinator, auto-wait, element-matcher]
    Src --> Drivers[drivers/ — raw-driver interface + platform impls]
    Src --> Agent[agent/ — session.ts for agent/CLI inspection]
    Src --> CLI2[cli/ — CLI entry point]
    Src --> Device[device/ — ADB, simctl device discovery]
    Src --> Report[report/ — console, json, junit reporters]
    Src --> Schemas[schemas/ — Element, Selector, DeviceInfo types]
```

All packages are managed by Bun workspaces and built with Turbo. The `prov` package is the only one that ships a binary (`prov` CLI). Other packages are libraries consumed by the apps or by `prov` itself.
