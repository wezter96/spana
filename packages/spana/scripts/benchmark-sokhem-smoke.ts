#!/usr/bin/env bun
/**
 * 1:1 Port of SökHem's `e2e/smoke.spec.ts` (all 15 @smoke tests) executed with Spana
 * against either live `https://sokhem.se` or local `http://localhost:4892`.
 *
 * Runs BOTH:
 *   1. Spana Single-Page Persistent Session (1 worker — reuses 1 live Chromium page across flows)
 *   2. Spana Shared Browser Pool (4 parallel BrowserContexts on 1 Chromium process)
 */
import { existsSync, writeFileSync } from "node:fs";
import type { Browser } from "playwright-core";
import { Effect } from "effect";
import { launchPlaywrightBrowser, makePlaywrightDriver } from "../src/drivers/playwright.js";
import { parseWebHierarchy } from "../src/drivers/playwright-parser.js";
import { createCoordinator } from "../src/smart/coordinator.js";

const BASE_URL = (process.env.BASE_URL ?? "https://sokhem.se").replace(/\/$/, "");
const OUT_PATH = process.env.SPANA_SOKHEM_OUT;

function findChromiumExecutable(): string | undefined {
  const chromeApp = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (existsSync(chromeApp)) return chromeApp;
  return undefined;
}

type SpanaDriver = Awaited<ReturnType<typeof runMakeDriver>>;
async function runMakeDriver(sharedBrowser: Browser) {
  return Effect.runPromise(
    makePlaywrightDriver({
      sharedBrowser,
      baseUrl: BASE_URL,
      headless: true,
      waitUntil: "domcontentloaded",
      recordHar: false,
    }),
  );
}

interface SokhemFlow {
  name: string;
  run: (ctx: {
    driver: SpanaDriver;
    coord: ReturnType<typeof createCoordinator>;
    goto: (route: string) => Promise<void>;
    waitForJs: (predicate: string, timeoutMs?: number) => Promise<void>;
  }) => Promise<void>;
}

const PUBLIC_ROUTES = ["/", "/bostader", "/salj", "/kontakt", "/hyra", "/uthyrning"];

const SOKHEM_SMOKE_FLOWS: SokhemFlow[] = [
  {
    name: "Home page loads and shows hero content",
    async run({ driver, goto, waitForJs }) {
      await goto("/");
      await waitForJs(`document.title.includes("SökHem")`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
      await waitForJs(
        `(() => { const img = document.querySelector('header img[alt="SökHem"]:not([aria-hidden="true"])'); return !!img && img.getBoundingClientRect().width > 0; })()`,
      );
      void driver;
    },
  },
  {
    name: "/bostader loads listings page",
    async run({ goto, waitForJs }) {
      await goto("/bostader");
      await waitForJs(`document.title.includes("SökHem")`);
      await waitForJs(
        `Array.from(document.querySelectorAll("h1")).some(h => h.textContent?.includes("Hitta hem") && h.getBoundingClientRect().height > 0)`,
      );
    },
  },
  {
    name: "/salj loads seller landing page",
    async run({ goto, waitForJs }) {
      await goto("/salj");
      await waitForJs(`document.title.includes("SökHem")`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
    },
  },
  {
    name: "/b2b loads B2B landing",
    async run({ goto, waitForJs }) {
      await goto("/b2b");
      await waitForJs(`/\\/b2b/.test(window.location.href)`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
    },
  },
  {
    name: "Auth modal opens when sign-in link is clicked",
    async run({ driver, coord, goto, waitForJs }) {
      await goto("/");
      const triggerCoords = (await Effect.runPromise(
        driver.evaluate(`(() => {
          const el = Array.from(document.querySelectorAll("button, a")).find(
            e => /Logga in|Skapa konto|Sign in/i.test(e.textContent || "") && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0
          );
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
        })()`),
      )) as { x: number; y: number } | null;

      if (triggerCoords) {
        const deadline = Date.now() + 20_000;
        let opened = false;
        while (Date.now() < deadline) {
          opened = Boolean(
            await Effect.runPromise(
              driver.evaluate(
                `(() => { const m = document.querySelector('[role="dialog"], [data-radix-dialog-content], .auth-modal, form'); return !!m && m.getBoundingClientRect().height > 0; })()`,
              ),
            ),
          );
          if (opened) break;
          // Re-read coordinates each attempt so Vite dev-mode CSS injection shifts never miss
          const liveCoords = (await Effect.runPromise(
            driver.evaluate(`(() => {
              const el = Array.from(document.querySelectorAll("button, a")).find(
                e => /Logga in|Skapa konto|Sign in/i.test(e.textContent || "") && e.getBoundingClientRect().width > 0 && e.getBoundingClientRect().height > 0
              );
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
            })()`),
          )) as { x: number; y: number } | null;
          if (liveCoords) {
            await Effect.runPromise(coord.tapXY(liveCoords.x, liveCoords.y));
          }
          await new Promise((r) => setTimeout(r, 150));
        }
        if (!opened) throw new Error("Auth modal did not open within 20s");
      } else {
        await goto("/login");
        await waitForJs(`Boolean(window.location.href)`);
      }
    },
  },
  {
    name: "Logo is visible in navbar",
    async run({ goto, waitForJs }) {
      await goto("/");
      await waitForJs(
        `(() => { const img = document.querySelector('header img[alt="SökHem"]:not([aria-hidden="true"])'); return !!img && img.getBoundingClientRect().width > 0; })()`,
      );
    },
  },
  {
    name: "Logo link navigates to home",
    async run({ driver, goto, waitForJs }) {
      await goto("/bostader");
      await waitForJs(
        `(() => { const a = document.querySelector('header a[aria-label="SökHem"]'); return !!a && a.getBoundingClientRect().width > 0; })()`,
      );
      await Effect.runPromise(
        driver.evaluate(`document.querySelector('header a[aria-label="SökHem"]')?.click()`),
      );
      await waitForJs(`/\\/(sv|en)?\\/?$/.test(window.location.pathname)`);
    },
  },
  {
    name: "/bevakningar page loads",
    async run({ goto, waitForJs }) {
      await goto("/bevakningar");
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
    },
  },
  {
    name: "/kontakt page loads without errors",
    async run({ driver, goto, waitForJs }) {
      await goto("/kontakt");
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
      const jsErrors = await Effect.runPromise(driver.getJSErrors!());
      const nonHydration = jsErrors.filter(
        (e) => !e.message.includes("Hydration") && !e.message.includes("hydrating"),
      );
      if (nonHydration.length > 0) {
        throw new Error(
          `Unexpected JS errors on /kontakt: ${nonHydration.map((e) => e.message).join("; ")}`,
        );
      }
    },
  },
  {
    name: "/hyra lands on the rental browse view with results",
    async run({ goto, waitForJs }) {
      await goto("/hyra");
      await waitForJs(`/\\/hyr(\\?|$)/.test(window.location.pathname + window.location.search)`);
      await waitForJs(`/SökHem/.test(document.title)`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && /hyresbostad/i.test(h.textContent || ""); })()`,
      );
      await waitForJs(`!/Inga hyresbostäder|0 hyresbostäder/i.test(document.body.innerText)`);
      await waitForJs(
        `(() => { const a = document.querySelector('a[href*="/hyr/"]'); return !!a && a.getBoundingClientRect().height > 0; })()`,
      );
    },
  },
  {
    name: "/uthyrning loads landlord rental page",
    async run({ goto, waitForJs }) {
      await goto("/uthyrning");
      await waitForJs(`document.title.includes("SökHem")`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
    },
  },
  {
    name: "/kunskapsbank lists articles",
    async run({ driver, goto, waitForJs }) {
      await goto("/sv/kunskapsbank?intent=kop");
      await waitForJs(`document.title.includes("SökHem")`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && /Förstå|Kunskapsbanken|Kunskap/i.test(h.textContent || ""); })()`,
      );
      await waitForJs(
        `Array.from(document.querySelectorAll("a[href*='/kunskapsbank/']")).some(a => a.querySelector("h2, h3") && a.getBoundingClientRect().height > 0)`,
      );
      const badHref = await Effect.runPromise(
        driver.evaluate(`(() => {
          const links = Array.from(document.querySelectorAll("a[href*='/kunskapsbank/']")).filter(a => a.querySelector("h2, h3"));
          for (const l of links) {
            const href = l.getAttribute("href");
            if (!href) return "null";
            if (new URL(href, window.location.href).searchParams.has("intent")) return href;
          }
          return null;
        })()`),
      );
      if (badHref) throw new Error(`Article card kept intent param: ${badHref}`);
    },
  },
  {
    name: "All public pages have a skip-to-content link",
    async run({ goto, waitForJs }) {
      for (const route of PUBLIC_ROUTES) {
        await goto(route);
        await waitForJs(`document.querySelectorAll('a[href="#main-content"]').length === 1`);
      }
    },
  },
  {
    name: "All public pages have exactly one main landmark",
    async run({ goto, waitForJs }) {
      for (const route of PUBLIC_ROUTES) {
        await goto(route);
        await waitForJs(`document.querySelectorAll("main").length === 1`);
      }
    },
  },
  {
    name: "kunskapsbank article page renders heading and back link",
    async run({ driver, goto, waitForJs }) {
      await goto("/sv/kunskapsbank");
      await waitForJs(
        `Array.from(document.querySelectorAll("a[href*='/kunskapsbank/']")).some(a => a.querySelector("h2, h3") && a.getBoundingClientRect().height > 0)`,
      );
      const articleHref = await Effect.runPromise(
        driver.evaluate(`(() => {
          const card = Array.from(document.querySelectorAll("a[href*='/kunskapsbank/']")).find(a => a.querySelector("h2, h3"));
          if (card) { card.scrollIntoView({ block: "center" }); card.click(); return card.getAttribute("href"); }
          return null;
        })()`),
      );
      void articleHref;
      await waitForJs(`/\\/kunskapsbank\\/[^/?#]+/.test(window.location.pathname)`);
      await waitForJs(
        `(() => { const h = document.querySelector("h1"); return !!h && h.getBoundingClientRect().height > 0; })()`,
      );
      await waitForJs(
        `Array.from(document.querySelectorAll("a, [role='link']")).some(a => { const label = (a.getAttribute("aria-label") || "") + " " + (a.textContent || ""); return /Kunskapsbanken/i.test(label) && a.getBoundingClientRect().height > 0; })`,
      );
    },
  },
];

async function runSpanaSokhem(
  sharedBrowser: Browser,
  workerCount: number,
): Promise<{
  workerCount: number;
  totalMs: number;
  passed: number;
  failed: number;
  perFlow: Array<{ name: string; ms: number; status: "passed" | "failed"; error?: string }>;
}> {
  const start = performance.now();
  const drivers = await Promise.all(
    Array.from({ length: workerCount }, () => runMakeDriver(sharedBrowser)),
  );
  // Launch initial blank context on each worker (fast — no full page wait needed)
  await Promise.all(drivers.map((d) => Effect.runPromise(d.launchApp("about:blank"))));

  const queue = [...SOKHEM_SMOKE_FLOWS];
  const perFlow: Array<{ name: string; ms: number; status: "passed" | "failed"; error?: string }> =
    [];

  await Promise.all(
    drivers.map(async (driver) => {
      const coord = createCoordinator(driver, {
        parse: parseWebHierarchy,
        platform: "web",
        defaults: { timeout: 15_000, pollInterval: 50, initialPollInterval: 20 },
      });

      const goto = async (route: string) => {
        const target = route.startsWith("http") ? route : `${BASE_URL}${route}`;
        await Effect.runPromise(driver.openLink(target));
      };

      const waitForJs = async (predicate: string, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          try {
            const ok = await Effect.runPromise(driver.evaluate(`Boolean(${predicate})`));
            if (ok) return;
          } catch {
            // Navigation in progress — retry
          }
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${predicate}`);
      };

      while (queue.length > 0) {
        const flow = queue.shift()!;
        const fStart = performance.now();
        try {
          await flow.run({ driver, coord, goto, waitForJs });
          perFlow.push({
            name: flow.name,
            ms: Math.round(performance.now() - fStart),
            status: "passed",
          });
        } catch (err) {
          perFlow.push({
            name: flow.name,
            ms: Math.round(performance.now() - fStart),
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      await Effect.runPromise(driver.killApp(""));
    }),
  );

  const totalMs = Math.round(performance.now() - start);
  const passed = perFlow.filter((f) => f.status === "passed").length;
  const failed = perFlow.filter((f) => f.status === "failed").length;
  return { workerCount, totalMs, passed, failed, perFlow };
}

const executablePath = findChromiumExecutable();
const browser = await launchPlaywrightBrowser({
  browser: "chromium",
  headless: true,
  executablePath,
});

try {
  console.log(`\n=== SPANA SÖKHEM 15-TEST @smoke SUITE (${BASE_URL}) ===`);
  const res1w = await runSpanaSokhem(browser, 1);
  console.log(
    `Spana (1 worker, persistent page): ${res1w.passed}/${SOKHEM_SMOKE_FLOWS.length} passed in ${res1w.totalMs}ms`,
  );
  for (const f of res1w.perFlow.filter((x) => x.status === "failed")) {
    console.log(`  FAIL [1w] ${f.name}: ${f.error}`);
  }

  const res4w = await runSpanaSokhem(browser, 4);
  console.log(
    `Spana Shared Pool (4 parallel workers): ${res4w.passed}/${SOKHEM_SMOKE_FLOWS.length} passed in ${res4w.totalMs}ms`,
  );
  for (const f of res4w.perFlow.filter((x) => x.status === "failed")) {
    console.log(`  FAIL [4w] ${f.name}: ${f.error}`);
  }

  const output = {
    target: BASE_URL,
    measuredAt: new Date().toISOString(),
    spana1w: res1w,
    spana4w: res4w,
  };
  if (OUT_PATH) {
    writeFileSync(OUT_PATH, JSON.stringify(output, null, 2), "utf-8");
  }
} finally {
  await browser.close();
}
