import { Given, When, Then } from "spana-test/steps";
import { buildFrameworkHref, navigateToHomeScreen } from "../support/navigation.js";

// --- Navigation steps ---

Given("I navigate to the home screen", navigateToHomeScreen);

Given("I navigate to {string}", async ({ app, expect: expectFn, platform }, path) => {
  if (platform === "ios") {
    // iOS: launch app then navigate via drawer menu
    // WDA's openUrl with custom schemes (spana://) routes through Safari
    // which breaks the WDA session, so we navigate through the UI instead.
    await app.launch();
    await expectFn({ accessibilityLabel: "Show navigation menu" }).toBeVisible({ timeout: 10_000 });
    const drawerItemId = `drawer-${(path as string).replace(/^\/+/, "")}-item`;
    await app.tap({ accessibilityLabel: "Show navigation menu" });
    await expectFn({ testID: drawerItemId }).toBeVisible({ timeout: 5_000 });
    await app.tap({ testID: drawerItemId });
  } else {
    await app.launch({
      clearState: platform === "android",
      deepLink: buildFrameworkHref(platform, path as string),
    });
  }
});

When("I open the navigation menu", async ({ app }) => {
  await app.tap({ accessibilityLabel: "Show navigation menu" });
});

When("I tap the {string} drawer item", async ({ app }, testID) => {
  await app.tap({ testID: testID as string });
});

When("I tap the {string} tab", async ({ app, platform }, label) => {
  const tabLabel = label as string;
  const androidTextMatch = platform === "android" ? /^Open (.+) tab$/i.exec(tabLabel) : null;
  if (androidTextMatch) {
    await app.tap({ text: androidTextMatch[1]! });
    return;
  }

  await app.tap({ accessibilityLabel: tabLabel });
});

When("I take a screenshot named {string}", async ({ app }, name) => {
  await app.takeScreenshot(name as string);
});

// --- Interaction steps ---

When("I type {string} into the {string} field", async ({ app, expect: expectFn }, text, testID) => {
  await expectFn({ testID: testID as string }).toBeVisible();
  await app.tap({ testID: testID as string });
  await app.inputText(text as string);
});

When("I dismiss the keyboard", async ({ app, platform }) => {
  // On iOS, hideKeyboard can accidentally tap the navigation menu.
  // Only explicitly dismiss on Android where the keyboard blocks interactions.
  if (platform !== "ios") {
    await app.dismissKeyboard();
  }
});

When("I tap the {string} element", async ({ app }, testID) => {
  await app.tap({ testID: testID as string });
});

When("I double tap the {string} element", async ({ app, platform }, testID) => {
  if (platform === "ios") {
    // On iOS, WDA's doubleTap doesn't fire React Native's onPress.
    // Use two explicit taps to trigger the React double-tap handler.
    await app.tap({ testID: testID as string });
    await app.tap({ testID: testID as string });
  } else {
    await app.doubleTap({ testID: testID as string });
  }
});

When("I long press the {string} element", async ({ app }, testID) => {
  await app.longPress({ testID: testID as string });
});

When("I scroll down", async ({ app }) => {
  await app.scroll("up");
});

When("I scroll until I see the element {string}", async ({ app }, testID) => {
  await app.scrollUntilVisible({ testID: testID as string });
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

Then("I should not see the element {string}", async ({ expect }, testID) => {
  await expect({ testID: testID as string }).toBeHidden();
});

Then("I should see the navigation menu button", async ({ expect }) => {
  await expect({ accessibilityLabel: "Show navigation menu" }).toBeVisible({ timeout: 10_000 });
});
