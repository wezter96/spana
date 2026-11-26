import { expect, test } from "bun:test";
import conformanceConfig from "./conformance.config.js";
import { resolveCapabilities } from "./src/runtime/capabilities.js";

test("supplies the UiAutomator2 driver for Android conformance without CLI capabilities", async () => {
  const result = await resolveCapabilities(conformanceConfig.execution?.appium ?? {}, {
    platform: "android",
  });
  expect(result["appium:automationName"]).toBe("UiAutomator2");
  expect(result["appium:app"]).toBe(conformanceConfig.apps?.android?.appPath);
});
