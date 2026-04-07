import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { DriverError } from "../errors.js";

const tempDirs: string[] = [];

type MockBrowserName = "chromium" | "firefox" | "webkit";

interface MockPage {
  __id: number;
  __handlers: {
    console: Array<
      (message: {
        type: () => string;
        text: () => string;
        location: () => { url?: string; lineNumber?: number; columnNumber?: number };
      }) => void
    >;
    pageerror: Array<(error: Error) => void>;
    download: Array<(download: MockDownload) => void>;
    requestfinished: Array<(request: MockRequest) => void>;
    requestfailed: Array<(request: MockRequest) => void>;
    close: Array<() => void>;
  };
  __url: string;
  on(event: string, handler: unknown): void;
  evaluate(
    script: string | ((...args: unknown[]) => unknown),
    ...args: unknown[]
  ): Promise<unknown>;
  mouse: {
    click(x: number, y: number): Promise<void>;
    dblclick(x: number, y: number): Promise<void>;
    move(x: number, y: number): Promise<void>;
    down(): Promise<void>;
    up(): Promise<void>;
  };
  keyboard: {
    type(text: string): Promise<void>;
    insertText(text: string): Promise<void>;
    press(key: string): Promise<void>;
  };
  screenshot(): Promise<Buffer>;
  viewportSize(): { width: number; height: number };
  goto(url: string): Promise<void>;
  close(): Promise<void>;
  context(): MockContext;
  goBack(): Promise<void>;
  url(): string;
  getByTestId(testId: string): { setInputFiles(path: string): Promise<void> };
  getByLabel(
    label: string,
    options?: { exact?: boolean },
  ): { setInputFiles(path: string): Promise<void> };
  getByText(
    text: string,
    options?: { exact?: boolean },
  ): { setInputFiles(path: string): Promise<void> };
}

interface MockContext {
  __pages: MockPage[];
  newPage(): Promise<MockPage>;
  pages(): MockPage[];
  clearCookies(): Promise<void>;
  addCookies(cookies: unknown): Promise<void>;
  cookies(): Promise<unknown>;
  storageState(options?: { path?: string }): Promise<unknown>;
  route(matcher: unknown, handler: unknown): Promise<void>;
  unroute(matcher: unknown, handler: unknown): Promise<void>;
  setOffline(offline: boolean): Promise<void>;
  newCDPSession(page: unknown): Promise<{ send(method: string, params?: unknown): Promise<void> }>;
  close(): Promise<void>;
}

interface MockDownload {
  saveAs(path: string): Promise<void>;
  suggestedFilename(): string;
  url(): string;
  page(): MockPage;
}

interface MockRequest {
  allHeaders(): Promise<Record<string, string>>;
  headers(): Record<string, string>;
  failure(): null | { errorText: string };
  frame(): never;
  method(): string;
  postData(): string | null;
  postDataBuffer(): Buffer | null;
  postDataJSON(): unknown;
  redirectedFrom(): null;
  redirectedTo(): null;
  resourceType(): string;
  response(): Promise<MockResponse | null>;
  sizes(): Promise<{
    requestBodySize: number;
    requestHeadersSize: number;
    responseBodySize: number;
    responseHeadersSize: number;
  }>;
  timing(): {
    startTime: number;
    domainLookupStart: number;
    domainLookupEnd: number;
    connectStart: number;
    secureConnectionStart: number;
    connectEnd: number;
    requestStart: number;
    responseStart: number;
    responseEnd: number;
  };
  url(): string;
}

interface MockResponse {
  allHeaders(): Promise<Record<string, string>>;
  body(): Promise<Buffer>;
  finished(): Promise<null>;
  frame(): never;
  fromServiceWorker(): boolean;
  headers(): Record<string, string>;
  headersArray(): Promise<Array<{ name: string; value: string }>>;
  headerValue(name: string): Promise<string | null>;
  headerValues(name: string): Promise<string[]>;
  httpVersion(): Promise<string>;
  json(): Promise<unknown>;
  ok(): boolean;
  request(): MockRequest;
  securityDetails(): Promise<null>;
  serverAddr(): Promise<null | { ipAddress: string; port: number }>;
  status(): number;
  statusText(): string;
  text(): Promise<string>;
  url(): string;
}

interface MockRequestInit {
  url: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  postData?: string;
  resourceType?: string;
  response?: {
    status?: number;
    statusText?: string;
    headers?: Record<string, string>;
    httpVersion?: string;
    body?: string;
    bodySize?: number;
    serverIPAddress?: string;
  };
  failureText?: string;
  timing?: Partial<ReturnType<MockRequest["timing"]>>;
}

const playwrightState = {
  events: [] as Array<[string, ...unknown[]]>,
  routes: [] as Array<{ matcher: unknown; handler: unknown }>,
  pages: [] as MockPage[],
  nextPageId: 1,
  launchError: undefined as Error | undefined,
  newPageError: undefined as Error | undefined,
  pressError: undefined as Error | undefined,
  tapError: undefined as Error | undefined,
  dumpHierarchyTree: {
    tag: "body",
    id: "root",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    visible: true,
    clickable: false,
    children: [],
  },
  screenshot: new Uint8Array([7, 8, 9]),
  viewport: { width: 111, height: 222 },
  cookies: [{ name: "session", value: "abc", domain: "example.com", path: "/" }],
  lastAddedCookies: undefined as unknown,
  storageState: {
    cookies: [{ name: "session", value: "abc", domain: "example.com", path: "/" }],
    origins: [],
  },
};

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spana-playwright-"));
  tempDirs.push(dir);
  return dir;
}

function resetPlaywrightState() {
  playwrightState.events = [];
  playwrightState.routes = [];
  playwrightState.pages = [];
  playwrightState.nextPageId = 1;
  playwrightState.launchError = undefined;
  playwrightState.newPageError = undefined;
  playwrightState.pressError = undefined;
  playwrightState.tapError = undefined;
  playwrightState.dumpHierarchyTree = {
    tag: "body",
    id: "root",
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    visible: true,
    clickable: false,
    children: [],
  };
  playwrightState.screenshot = new Uint8Array([7, 8, 9]);
  playwrightState.viewport = { width: 111, height: 222 };
  playwrightState.cookies = [{ name: "session", value: "abc", domain: "example.com", path: "/" }];
  playwrightState.lastAddedCookies = undefined;
  playwrightState.storageState = {
    cookies: [{ name: "session", value: "abc", domain: "example.com", path: "/" }],
    origins: [],
  };
}

function latestPage(): MockPage {
  const page = playwrightState.pages.at(-1);
  if (!page) {
    throw new Error("No mock Playwright page exists.");
  }
  return page;
}

function makeLocator(kind: string, value: string, options?: unknown) {
  return {
    async setInputFiles(path: string) {
      playwrightState.events.push(["setInputFiles", kind, value, options, path]);
    },
  };
}

function makePage(browserName: MockBrowserName, context: MockContext): MockPage {
  const page: MockPage = {
    __id: playwrightState.nextPageId++,
    __url: "about:blank",
    __handlers: {
      console: [],
      pageerror: [],
      download: [],
      requestfinished: [],
      requestfailed: [],
      close: [],
    },
    on(event: string, handler: unknown) {
      playwrightState.events.push(["pageOn", page.__id, event]);
      if (event === "console")
        page.__handlers.console.push(handler as MockPage["__handlers"]["console"][number]);
      if (event === "pageerror")
        page.__handlers.pageerror.push(handler as MockPage["__handlers"]["pageerror"][number]);
      if (event === "download")
        page.__handlers.download.push(handler as MockPage["__handlers"]["download"][number]);
      if (event === "requestfinished") {
        page.__handlers.requestfinished.push(
          handler as MockPage["__handlers"]["requestfinished"][number],
        );
      }
      if (event === "requestfailed") {
        page.__handlers.requestfailed.push(
          handler as MockPage["__handlers"]["requestfailed"][number],
        );
      }
      if (event === "close")
        page.__handlers.close.push(handler as MockPage["__handlers"]["close"][number]);
    },
    async evaluate(script: string | ((...args: unknown[]) => unknown), ...args: unknown[]) {
      playwrightState.events.push(["evaluate", script, ...args]);
      if (typeof script === "string" && script.includes("return walk(document.body)")) {
        return playwrightState.dumpHierarchyTree;
      }
      if (
        typeof script === "string" &&
        script.includes("document.elementFromPoint") &&
        playwrightState.tapError
      ) {
        throw playwrightState.tapError;
      }
      if (typeof script === "function") {
        return script(...args);
      }
      return undefined;
    },
    mouse: {
      async click(x: number, y: number) {
        playwrightState.events.push(["mouseClick", x, y]);
      },
      async dblclick(x: number, y: number) {
        playwrightState.events.push(["dblclick", x, y]);
      },
      async move(x: number, y: number) {
        playwrightState.events.push(["mouseMove", x, y]);
      },
      async down() {
        playwrightState.events.push(["mouseDown"]);
      },
      async up() {
        playwrightState.events.push(["mouseUp"]);
      },
    },
    keyboard: {
      async type(text: string) {
        playwrightState.events.push(["keyboardType", text]);
      },
      async insertText(text: string) {
        playwrightState.events.push(["keyboardInsertText", text]);
      },
      async press(key: string) {
        if (playwrightState.pressError) throw playwrightState.pressError;
        playwrightState.events.push(["keyboardPress", key]);
      },
    },
    async screenshot() {
      playwrightState.events.push(["screenshot"]);
      return Buffer.from(playwrightState.screenshot);
    },
    viewportSize() {
      return playwrightState.viewport;
    },
    async goto(url: string) {
      page.__url = url;
      playwrightState.events.push(["goto", page.__id, url]);
    },
    async close() {
      playwrightState.events.push(["pageClose", page.__id, browserName]);
      context.__pages = context.__pages.filter((candidate) => candidate !== page);
      playwrightState.pages = playwrightState.pages.filter((candidate) => candidate !== page);
      for (const handler of page.__handlers.close) {
        handler();
      }
    },
    context() {
      return context;
    },
    async goBack() {
      playwrightState.events.push(["goBack", page.__id]);
    },
    url() {
      return page.__url;
    },
    getByTestId(testId: string) {
      return makeLocator("testID", testId);
    },
    getByLabel(label: string, options?: { exact?: boolean }) {
      return makeLocator("label", label, options);
    },
    getByText(text: string, options?: { exact?: boolean }) {
      return makeLocator("text", text, options);
    },
  };

  playwrightState.pages.push(page);
  return page;
}

function makeContext(browserName: MockBrowserName): MockContext {
  const context: MockContext = {
    __pages: [],
    async newPage() {
      if (playwrightState.newPageError) throw playwrightState.newPageError;
      playwrightState.events.push(["newPage", browserName]);
      const page = makePage(browserName, context);
      context.__pages.push(page);
      return page;
    },
    pages() {
      return [...context.__pages];
    },
    async clearCookies() {
      playwrightState.events.push(["clearCookies"]);
    },
    async addCookies(cookies: unknown) {
      playwrightState.lastAddedCookies = cookies;
      playwrightState.events.push(["addCookies", cookies]);
    },
    async cookies() {
      playwrightState.events.push(["cookies"]);
      return playwrightState.cookies;
    },
    async storageState(options?: { path?: string }) {
      playwrightState.events.push(["storageState", options]);
      if (options?.path) {
        await writeFile(options.path, JSON.stringify(playwrightState.storageState), "utf8");
      }
      return playwrightState.storageState;
    },
    async route(matcher: unknown, handler: unknown) {
      playwrightState.routes.push({ matcher, handler });
      playwrightState.events.push(["route", matcher]);
    },
    async unroute(matcher: unknown, handler: unknown) {
      playwrightState.routes = playwrightState.routes.filter(
        (route) => route.matcher !== matcher || route.handler !== handler,
      );
      playwrightState.events.push(["unroute", matcher]);
    },
    async setOffline(offline: boolean) {
      playwrightState.events.push(["setOffline", offline]);
    },
    async newCDPSession(_page: unknown) {
      playwrightState.events.push(["newCDPSession", browserName]);
      return {
        async send(method: string, params?: unknown) {
          playwrightState.events.push(["cdpSend", method, params]);
        },
      };
    },
    async close() {
      playwrightState.events.push(["contextClose", browserName]);
      context.__pages = [];
      playwrightState.pages = [];
    },
  };

  return context;
}

function makeBrowserType(browserName: MockBrowserName) {
  return {
    async launch(options: { headless?: boolean }) {
      if (playwrightState.launchError) throw playwrightState.launchError;
      playwrightState.events.push(["launch", browserName, options]);

      return {
        async newContext(contextOptions?: { acceptDownloads?: boolean; storageState?: string }) {
          playwrightState.events.push(["newContext", browserName, contextOptions]);
          return makeContext(browserName);
        },
        async close() {
          playwrightState.events.push(["browserClose", browserName]);
        },
      };
    },
  };
}

function emitConsole(
  type: string,
  text: string,
  location: { url?: string; lineNumber?: number; columnNumber?: number } = {},
  page = latestPage(),
) {
  for (const handler of page.__handlers.console) {
    handler({
      type: () => type,
      text: () => text,
      location: () => location,
    });
  }
}

function emitPageError(error: Error, page = latestPage()) {
  for (const handler of page.__handlers.pageerror) {
    handler(error);
  }
}

function emitDownload(
  {
    suggestedFilename,
    url,
    content = `download:${suggestedFilename}`,
  }: {
    suggestedFilename: string;
    url: string;
    content?: string;
  },
  page = latestPage(),
) {
  const download: MockDownload = {
    async saveAs(path: string) {
      playwrightState.events.push(["saveAsDownload", path, suggestedFilename]);
      writeFileSync(path, content, "utf8");
    },
    suggestedFilename: () => suggestedFilename,
    url: () => url,
    page: () => page,
  };

  for (const handler of page.__handlers.download) {
    handler(download);
  }
}

function buildRequest(init: MockRequestInit): MockRequest {
  const requestHeaders = init.requestHeaders ?? {};
  const responseHeaders = init.response?.headers ?? {};
  const body = init.response?.body ?? "";
  const timing = {
    startTime: Date.now(),
    domainLookupStart: -1,
    domainLookupEnd: -1,
    connectStart: -1,
    secureConnectionStart: -1,
    connectEnd: -1,
    requestStart: 4,
    responseStart: 16,
    responseEnd: 34,
    ...init.timing,
  };

  let request!: MockRequest;

  const response: MockResponse | null = init.failureText
    ? null
    : {
        allHeaders: async () => responseHeaders,
        body: async () => Buffer.from(body),
        finished: async () => null,
        frame: () => {
          throw new Error("frame() not implemented in mock");
        },
        fromServiceWorker: () => false,
        headers: () => responseHeaders,
        headersArray: async () =>
          Object.entries(responseHeaders).map(([name, value]) => ({ name, value })),
        headerValue: async (name: string) => responseHeaders[name.toLowerCase()] ?? null,
        headerValues: async (name: string) => {
          const value = responseHeaders[name.toLowerCase()];
          return value ? [value] : [];
        },
        httpVersion: async () => init.response?.httpVersion ?? "HTTP/1.1",
        json: async () => JSON.parse(body || "{}"),
        ok: () => (init.response?.status ?? 200) >= 200 && (init.response?.status ?? 200) < 300,
        request: () => request,
        securityDetails: async () => null,
        serverAddr: async () =>
          init.response?.serverIPAddress
            ? { ipAddress: init.response.serverIPAddress, port: 443 }
            : null,
        status: () => init.response?.status ?? 200,
        statusText: () => init.response?.statusText ?? "OK",
        text: async () => body,
        url: () => init.url,
      };

  request = {
    allHeaders: async () => requestHeaders,
    headers: () => requestHeaders,
    failure: () => (init.failureText ? { errorText: init.failureText } : null),
    frame: () => {
      throw new Error("frame() not implemented in mock");
    },
    method: () => init.method ?? "GET",
    postData: () => init.postData ?? null,
    postDataBuffer: () => (init.postData ? Buffer.from(init.postData) : null),
    postDataJSON: () => (init.postData ? JSON.parse(init.postData) : null),
    redirectedFrom: () => null,
    redirectedTo: () => null,
    resourceType: () => init.resourceType ?? "fetch",
    response: async () => response,
    sizes: async () => ({
      requestBodySize: init.postData ? Buffer.byteLength(init.postData) : 0,
      requestHeadersSize: -1,
      responseBodySize: init.response?.bodySize ?? Buffer.byteLength(body),
      responseHeadersSize: -1,
    }),
    timing: () => timing,
    url: () => init.url,
  };

  return request;
}

function emitRequestFinished(init: MockRequestInit, page = latestPage()) {
  const request = buildRequest(init);
  for (const handler of page.__handlers.requestfinished) {
    handler(request);
  }
}

function emitRequestFailed(init: MockRequestInit, page = latestPage()) {
  const request = buildRequest({
    ...init,
    failureText: init.failureText ?? "net::ERR_FAILED",
  });
  for (const handler of page.__handlers.requestfailed) {
    handler(request);
  }
}

mock.module("playwright-core", () => ({
  chromium: makeBrowserType("chromium"),
  firefox: makeBrowserType("firefox"),
  webkit: makeBrowserType("webkit"),
}));

let importCounter = 0;

async function importFreshDriver() {
  importCounter += 1;
  return import(new URL(`./playwright.ts?case=${importCounter}`, import.meta.url).href) as Promise<
    typeof import("./playwright.js")
  >;
}

beforeEach(() => {
  resetPlaywrightState();
});

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Playwright driver adapter", () => {
  test("creates a driver and routes web lifecycle/navigation calls through Playwright", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        headless: false,
        baseUrl: "https://base.test",
      }),
    );

    const hierarchy = await Effect.runPromise(driver.dumpHierarchy());
    await Effect.runPromise(driver.tapAtCoordinate(5, 7));
    await Effect.runPromise(driver.launchApp(""));
    await Effect.runPromise(
      driver.launchApp("https://ignored.test", { deepLink: "https://deep.test" }),
    );
    await Effect.runPromise(driver.clearAppState("ignored"));
    await Effect.runPromise(driver.openLink("https://open.test"));
    await Effect.runPromise(driver.back());
    await Effect.runPromise(driver.stopApp("ignored"));
    await Effect.runPromise(driver.killApp("ignored"));
    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(JSON.parse(hierarchy)).toMatchObject({ tag: "body", id: "root" });
    expect(playwrightState.events).toContainEqual(["launch", "chromium", { headless: false }]);
    expect(playwrightState.events).toContainEqual([
      "newContext",
      "chromium",
      { acceptDownloads: true },
    ]);
    expect(playwrightState.events).toContainEqual(["goto", 1, "https://base.test"]);
    expect(playwrightState.events).toContainEqual(["goto", 1, "https://deep.test"]);
    expect(playwrightState.events).toContainEqual(["goto", 1, "https://open.test"]);
    expect(playwrightState.events).toContainEqual(["goto", 1, "about:blank"]);
    expect(playwrightState.events).toContainEqual(["clearCookies"]);
    expect(
      playwrightState.events.some(
        ([type, script]) =>
          type === "evaluate" &&
          typeof script === "string" &&
          script.includes("localStorage.clear()") &&
          script.includes("sessionStorage.clear()"),
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["goBack", 1]);
    expect(playwrightState.events).toContainEqual(["pageClose", 1, "chromium"]);
    expect(playwrightState.events).toContainEqual(["contextClose", "chromium"]);
    expect(playwrightState.events).toContainEqual(["browserClose", "chromium"]);
    expect(info).toEqual({
      platform: "web",
      deviceId: "playwright-chromium",
      name: "Chromium",
      isEmulator: false,
      screenWidth: 111,
      screenHeight: 222,
      driverType: "playwright",
    });
  });

  test("supports browser selection and initial storage state", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(
      makePlaywrightDriver({
        browser: "firefox",
        storageState: "/tmp/auth.json",
      }),
    );

    const info = await Effect.runPromise(driver.getDeviceInfo());

    expect(playwrightState.events).toContainEqual(["launch", "firefox", { headless: true }]);
    expect(playwrightState.events).toContainEqual([
      "newContext",
      "firefox",
      { acceptDownloads: true, storageState: "/tmp/auth.json" },
    ]);
    expect(info.deviceId).toBe("playwright-firefox");
    expect(info.name).toBe("Firefox");
  });

  test("supports network helpers and auth state management", async () => {
    const tempDir = createTempDir();
    const cookieInputPath = join(tempDir, "input-cookies.json");
    const cookieOutputPath = join(tempDir, "output-cookies.json");
    const authStatePath = join(tempDir, "auth-state.json");
    const cookies = [{ name: "pref", value: "dark", domain: "example.com", path: "/" }];
    writeFileSync(cookieInputPath, JSON.stringify(cookies), "utf8");

    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({}));

    await Effect.runPromise(driver.launchApp("https://app.test"));
    await Effect.runPromise(driver.mockNetwork!(/\/api\/user$/, { json: { ok: true } }));
    await Effect.runPromise(driver.blockNetwork!("**/ads"));
    await Effect.runPromise(driver.saveCookies!(cookieOutputPath));
    await Effect.runPromise(driver.loadCookies!(cookieInputPath));
    await Effect.runPromise(driver.saveAuthState!(authStatePath));
    await Effect.runPromise(driver.loadAuthState!(authStatePath));
    await Effect.runPromise(driver.clearNetworkMocks!());

    expect(
      playwrightState.events.some(
        ([type, matcher]) => type === "route" && matcher instanceof RegExp,
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["route", "**/ads"]);
    expect(
      playwrightState.events.some(
        ([type, matcher]) => type === "unroute" && matcher instanceof RegExp,
      ),
    ).toBe(true);
    expect(playwrightState.events).toContainEqual(["unroute", "**/ads"]);
    expect(JSON.parse(readFileSync(cookieOutputPath, "utf8"))).toEqual(playwrightState.cookies);
    expect(playwrightState.lastAddedCookies).toEqual(cookies);
    expect(JSON.parse(readFileSync(authStatePath, "utf8"))).toEqual(playwrightState.storageState);
    expect(playwrightState.events).toContainEqual([
      "newContext",
      "chromium",
      { acceptDownloads: true, storageState: authStatePath },
    ]);
    expect(playwrightState.events).toContainEqual(["goto", 2, "https://app.test"]);
    expect(playwrightState.events).toContainEqual(["pageClose", 1, "chromium"]);
    expect(playwrightState.events).toContainEqual(["contextClose", "chromium"]);
  });

  test("captures browser console logs and page errors for diagnostics", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({}));

    await Effect.runPromise(driver.launchApp("https://app.test"));
    emitConsole("info", "spana web flow ready", {
      url: "https://app.test",
      lineNumber: 12,
      columnNumber: 4,
    });
    emitPageError(new Error("boom"));

    expect(await Effect.runPromise(driver.getConsoleLogs!())).toEqual([
      {
        type: "info",
        text: "spana web flow ready",
        location: {
          url: "https://app.test",
          lineNumber: 12,
          columnNumber: 4,
        },
      },
    ]);
    expect(await Effect.runPromise(driver.getJSErrors!())).toEqual([
      {
        name: "Error",
        message: "boom",
        stack: expect.any(String),
      },
    ]);
  });

  test("supports uploads, downloads, tab management, HAR export, and verbose logging", async () => {
    const tempDir = createTempDir();
    const uploadPath = join(tempDir, "upload.txt");
    const downloadPath = join(tempDir, "download.txt");
    const logs: string[] = [];
    writeFileSync(uploadPath, "upload me", "utf8");

    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const { makePlaywrightDriver } = await importFreshDriver();
      const driver = await Effect.runPromise(makePlaywrightDriver({ verboseLogging: true }));

      await Effect.runPromise(driver.beginFlow!("Web power flow"));
      await Effect.runPromise(driver.launchApp("https://app.test"));

      expect(await Effect.runPromise(driver.getTabIds!())).toEqual(["tab-1"]);

      await Effect.runPromise(driver.uploadFile!({ testID: "upload-input" }, uploadPath));

      const downloadPromise = Effect.runPromise(driver.downloadFile!(downloadPath));
      emitDownload({
        suggestedFilename: "report.txt",
        url: "https://app.test/download/report.txt",
        content: "downloaded from spana",
      });
      await downloadPromise;

      const newTabId = await Effect.runPromise(driver.newTab!("https://app.test/?tab=2"));
      expect(newTabId).toBe("tab-2");
      expect(await Effect.runPromise(driver.getTabIds!())).toEqual(["tab-1", "tab-2"]);

      await Effect.runPromise(driver.switchToTab!(1));
      await Effect.runPromise(driver.closeTab!());
      expect(await Effect.runPromise(driver.getTabIds!())).toEqual(["tab-1"]);

      emitRequestFinished({
        url: "https://app.test/api/demo?value=1",
        method: "GET",
        requestHeaders: { accept: "application/json" },
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: '{"ok":true}',
          bodySize: 11,
          serverIPAddress: "127.0.0.1",
        },
      });
      emitRequestFailed({
        url: "https://app.test/api/broken",
        method: "POST",
        requestHeaders: { "content-type": "application/json" },
        postData: '{"broken":true}',
        failureText: "net::ERR_FAILED",
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      const har = await Effect.runPromise(driver.getHAR!());

      expect(readFileSync(downloadPath, "utf8")).toBe("downloaded from spana");
      expect(playwrightState.events).toContainEqual([
        "setInputFiles",
        "testID",
        "upload-input",
        undefined,
        uploadPath,
      ]);
      expect(playwrightState.events).toContainEqual(["saveAsDownload", downloadPath, "report.txt"]);
      expect(har.log.pages.map((entry) => entry.id)).toEqual(["tab-1", "tab-2"]);
      expect(har.log.entries).toHaveLength(2);
      const successfulEntry = har.log.entries.find(
        (entry) => entry.request.url === "https://app.test/api/demo?value=1",
      );
      const failedEntry = har.log.entries.find(
        (entry) => entry.request.url === "https://app.test/api/broken",
      );
      expect(successfulEntry).toBeDefined();
      expect(failedEntry).toBeDefined();
      expect(successfulEntry).toMatchObject({
        request: { method: "GET", url: "https://app.test/api/demo?value=1" },
        response: { status: 200 },
      });
      expect(failedEntry).toMatchObject({
        request: { method: "POST", url: "https://app.test/api/broken" },
        _failureText: "net::ERR_FAILED",
      });
      expect(logs.some((entry) => entry.includes("[spana:web] [Web power flow] beginFlow"))).toBe(
        true,
      );
      expect(logs.some((entry) => entry.includes("downloadFile"))).toBe(true);

      await Effect.runPromise(driver.beginFlow!("Fresh flow"));
      expect(await Effect.runPromise(driver.getTabIds!())).toEqual(["tab-1"]);
      expect(await Effect.runPromise(driver.getConsoleLogs!())).toEqual([]);
      expect(await Effect.runPromise(driver.getJSErrors!())).toEqual([]);
      expect((await Effect.runPromise(driver.getHAR!())).log.entries).toEqual([]);
    } finally {
      console.log = originalLog;
    }
  });

  test("uses CDP for chromium network throttling and rejects non-chromium throttling", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({ browser: "chromium" }));

    await Effect.runPromise(
      driver.setNetworkConditions!({
        offline: true,
        latencyMs: 120,
        downloadThroughputKbps: 800,
        uploadThroughputKbps: 400,
      }),
    );

    expect(playwrightState.events).toContainEqual(["setOffline", true]);
    expect(playwrightState.events).toContainEqual(["newCDPSession", "chromium"]);
    expect(playwrightState.events).toContainEqual(["cdpSend", "Network.enable", undefined]);
    expect(playwrightState.events).toContainEqual([
      "cdpSend",
      "Network.emulateNetworkConditions",
      {
        offline: true,
        latency: 120,
        downloadThroughput: 102400,
        uploadThroughput: 51200,
      },
    ]);

    resetPlaywrightState();

    const firefoxDriver = await Effect.runPromise(makePlaywrightDriver({ browser: "firefox" }));
    const result = await Effect.runPromise(
      Effect.either(firefoxDriver.setNetworkConditions!({ latencyMs: 10 })),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("only supported with the chromium browser");
    }
  });

  test("wraps browser launch failures in DriverError", async () => {
    playwrightState.launchError = new Error("browser exploded");

    const { makePlaywrightDriver } = await importFreshDriver();
    const result = await Effect.runPromise(Effect.either(makePlaywrightDriver({})));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Failed to launch browser: Error: browser exploded");
    }
  });

  test("wraps page creation failures in DriverError", async () => {
    playwrightState.newPageError = new Error("page exploded");

    const { makePlaywrightDriver } = await importFreshDriver();
    const result = await Effect.runPromise(Effect.either(makePlaywrightDriver({})));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Failed to create page: Error: page exploded");
    }
  });

  test("wraps page interaction failures in DriverError", async () => {
    const { makePlaywrightDriver } = await importFreshDriver();
    const driver = await Effect.runPromise(makePlaywrightDriver({}));
    playwrightState.pressError = new Error("press exploded");

    const result = await Effect.runPromise(Effect.either(driver.pressKey("Enter")));

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toBeInstanceOf(DriverError);
      expect(result.left.message).toContain("Failed to press key Enter: Error: press exploded");
    }
  });
});
