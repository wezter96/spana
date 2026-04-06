import { Given, When, Then } from "spana-test/steps";
import type { Platform } from "spana-test";

const WEB_BASE_URL = "http://127.0.0.1:8081";

function buildHref(platform: Platform, path: string): string {
  return platform === "web" ? `${WEB_BASE_URL}${path}` : `spana://${path}`;
}

// --- Navigation steps ---

Given("I navigate to the home screen", async ({ app, platform }) => {
  // Stop and relaunch via deeplink to reset navigation state.
  // On physical devices, openLink alone doesn't reset the navigation stack.
  try {
    await app.stop();
  } catch {
    /* may not be running */
  }
  await app.launch({ deepLink: buildHref(platform, "/") });
});

Given("I navigate to {string}", async ({ app, platform }, path) => {
  await app.openLink(buildHref(platform, path as string));
});

When("I open the navigation menu", async ({ app }) => {
  await app.tap({ accessibilityLabel: "Show navigation menu" });
});

When("I tap the {string} drawer item", async ({ app }, testID) => {
  await app.tap({ testID: testID as string });
});

When("I tap the {string} tab", async ({ app }, label) => {
  await app.tap({ accessibilityLabel: label as string });
});

When("I take a screenshot named {string}", async ({ app }, name) => {
  await app.takeScreenshot(name as string);
});

// --- Assertion steps ---

Then("I should see the element {string}", async ({ expect }, testID) => {
  await expect({ testID: testID as string }).toBeVisible();
});

Then("I should see the element {string} within {int}ms", async ({ expect }, testID, timeout) => {
  await expect({ testID: testID as string }).toBeVisible({ timeout: timeout as number });
});

Then("I should see the text {string}", async ({ expect }, text) => {
  await expect({ text: text as string }).toBeVisible();
});

Then("the element {string} should have text {string}", async ({ expect }, testID, text) => {
  await expect({ testID: testID as string }).toHaveText(text as string);
});

Then("I should see the navigation menu button", async ({ expect }) => {
  await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({ timeout: 10_000 });
});
