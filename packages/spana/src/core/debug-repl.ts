import * as repl from "node:repl";
import { Effect } from "effect";
import type { PromiseApp } from "../api/app.js";
import type { PromiseExpectation } from "../api/expect.js";
import type { RawDriverService } from "../drivers/raw-driver.js";
import type { Element } from "../schemas/element.js";
import type { Platform, Selector } from "../schemas/selector.js";
import { flattenElements } from "../smart/element-matcher.js";

export interface DebugReplContext {
  app: PromiseApp;
  expect: (selector: Selector) => PromiseExpectation;
  driver: RawDriverService;
  error: Error;
  flowName: string;
  platform: Platform;
  parseHierarchy: (raw: string) => Element;
}

let didStartDebugRepl = false;

function toSuggestedSelectors(root: Element) {
  return flattenElements(root)
    .filter((el) => el.visible !== false && (el.id || el.text || el.accessibilityLabel))
    .map((el) => ({
      suggestedSelector: el.id
        ? { testID: el.id }
        : el.accessibilityLabel
          ? { accessibilityLabel: el.accessibilityLabel }
          : el.text
            ? { text: el.text }
            : "",
      elementType: el.elementType,
      text: el.text,
      accessibilityLabel: el.accessibilityLabel,
      bounds: el.bounds,
      id: el.id,
    }));
}

export function resetDebugReplState(): void {
  didStartDebugRepl = false;
}

export async function runDebugReplOnce(context: DebugReplContext): Promise<boolean> {
  if (didStartDebugRepl) {
    return false;
  }
  didStartDebugRepl = true;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Skipping debug REPL because stdin/stdout is not interactive.");
    return false;
  }

  const hierarchy = async () =>
    context.parseHierarchy(await Effect.runPromise(context.driver.dumpHierarchy()));
  const selectors = async () => toSuggestedSelectors(await hierarchy());

  console.log("");
  console.log(`Entering debug REPL for failed flow "${context.flowName}" on ${context.platform}.`);
  console.log(
    "Available bindings: app, expect, driver, platform, flowName, error, hierarchy(), selectors(), help()",
  );
  console.log('Use top-level await for async calls, for example: await app.tap({ text: "Login" })');

  const replServer = repl.start({
    prompt: `spana:${context.platform}> `,
    ignoreUndefined: true,
    useGlobal: false,
  });

  replServer.context.app = context.app;
  replServer.context.expect = context.expect;
  replServer.context.driver = context.driver;
  replServer.context.platform = context.platform;
  replServer.context.flowName = context.flowName;
  replServer.context.error = context.error;
  replServer.context.hierarchy = hierarchy;
  replServer.context.selectors = selectors;
  replServer.context.help = () => {
    console.log("app        Promise-based app API with auto-waiting");
    console.log("expect     Assertion helper, e.g. await expect({ text: 'Done' }).toBeVisible()");
    console.log("driver     Raw driver service");
    console.log("hierarchy  Async helper returning the parsed UI tree");
    console.log("selectors  Async helper returning suggested selectors");
    console.log(".exit      Leave the REPL");
  };

  await new Promise<void>((resolve) => replServer.on("exit", resolve));
  console.log("");
  return true;
}
