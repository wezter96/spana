---
title: Gherkin / BDD
description: Write tests as .feature files with Given/When/Then step definitions.
---

Spana supports Gherkin-style BDD tests alongside the standard flow API. Write human-readable `.feature` files, then implement step definitions in TypeScript.

## Project structure

```
flows/
  login/
    login.feature          # Gherkin scenarios
    steps/
      login.steps.ts       # Step definitions
  dashboard.flow.ts        # Standard flow (both styles coexist)
```

Step files must live in a `steps/` subdirectory next to the `.feature` file. Spana auto-discovers and loads them.

## Writing a feature file

```gherkin title="flows/login/login.feature"
@e2e @auth
Feature: User login

  Background:
    Given I am on the login screen

  @smoke @web @android @ios
  Scenario: Successful login
    When I enter "user@example.com" in the email field
    And I enter "password123" in the password field
    And I tap the login button
    Then I should see the text "Welcome"

  @web @android
  Scenario Outline: Navigate to <page>
    When I navigate to "<path>"
    Then I should see the element "<selector>"

    Examples:
      | page      | path      | selector      |
      | dashboard | /dash     | dash-title    |
      | settings  | /settings | settings-title|
```

### Tags as platform filters

Tags like `@web`, `@android`, and `@ios` on a scenario control which platforms it runs on. Other tags (like `@smoke`, `@e2e`) can be used with `--tag` to filter runs.

### Background

`Background` steps run before every scenario in the feature, similar to a `beforeEach` hook.

### Scenario Outline

Use `Scenario Outline` with an `Examples` table to run the same scenario with different data. Placeholders like `<path>` are replaced with values from each row.

## Writing step definitions

Step definitions map Gherkin steps to TypeScript functions. Import them from `spana-test/steps`:

```ts title="flows/login/steps/login.steps.ts"
import { Given, When, Then } from "spana-test/steps";

Given("I am on the login screen", async ({ app }) => {
  await app.launch({ deepLink: "myapp://login" });
});

When("I enter {string} in the email field", async ({ app }, email) => {
  await app.tap({ testID: "email-input" });
  await app.inputText(email as string);
});

When("I enter {string} in the password field", async ({ app }, password) => {
  await app.tap({ testID: "password-input" });
  await app.inputText(password as string);
});

When("I tap the login button", async ({ app }) => {
  await app.tap({ testID: "login-button" });
});

Then("I should see the text {string}", async ({ expect }, text) => {
  await expect({ text: text as string }).toBeVisible();
});

Then("I should see the element {string}", async ({ expect }, testID) => {
  await expect({ testID: testID as string }).toBeVisible();
});
```

### Step keywords

| Function | Purpose                       |
| -------- | ----------------------------- |
| `Given`  | Set up preconditions          |
| `When`   | Perform actions               |
| `Then`   | Assert outcomes               |
| `And`    | Continue the previous keyword |
| `But`    | Negative continuation         |

All five register steps the same way -- the keyword is for readability. `And` and `But` inherit the type of the preceding step.

### Pattern matching

Step patterns support two forms:

**String patterns** with `{string}`, `{int}`, and `{float}` placeholders:

```ts
Then("I should see the element {string} within {int}ms", async ({ expect }, testID, timeout) => {
  await expect({ testID: testID as string }).toBeVisible({ timeout: timeout as number });
});
```

**Regular expressions** for complex matching:

```ts
When(/^I swipe (left|right|up|down)$/, async ({ app }, direction) => {
  await app.swipe(direction as string);
});
```

Captured groups are passed as additional arguments after the context.

### Step context

Every step function receives the same context available in standard flows:

| Property   | Description                                          |
| ---------- | ---------------------------------------------------- |
| `app`      | Full `PromiseApp` API (tap, inputText, scroll, etc.) |
| `expect`   | Assertion helper                                     |
| `platform` | Current platform (`"web"`, `"android"`, `"ios"`)     |
| `config`   | Resolved config object                               |

## Hooks

Run setup/teardown code before or after each scenario:

```ts
import { Before, After } from "spana-test/steps";

// Runs before every scenario
Before(async ({ app }) => {
  await app.launch();
});

// Runs after every scenario
After(async ({ app }) => {
  await app.takeScreenshot("after-scenario");
});
```

### Tag-filtered hooks

Restrict hooks to scenarios with specific tags:

```ts
// Only runs before scenarios tagged @auth
Before("@auth", async ({ app }) => {
  await app.launch({ deepLink: "myapp://login" });
});
```

## World (shared state)

Use `defineWorld` to share state and helper methods across steps within a scenario:

```ts title="flows/login/steps/world.ts"
import { defineWorld } from "spana-test/steps";

export default defineWorld({
  // Fresh state for each scenario
  create: () => ({
    currentUser: "",
    authToken: "",
  }),

  // Helper methods available in step context
  methods: (ctx) => ({
    async loginAs(email: string, password: string) {
      await ctx.app.tap({ testID: "email-input" });
      await ctx.app.inputText(email);
      await ctx.app.tap({ testID: "password-input" });
      await ctx.app.inputText(password);
      await ctx.app.tap({ testID: "login-button" });
      ctx.currentUser = email;
    },
  }),
});
```

World state is created fresh for each scenario. The `state` map is also available for arbitrary key-value storage across steps.

## Running Gherkin tests

Gherkin tests run with the same CLI as standard flows:

```bash
# Run all tests (flows + features)
spana test

# Filter by tag
spana test --tag @smoke

# Filter by name
spana test --grep "login"

# Run only on specific platforms
spana test --platform web,android
```

## Mixing flows and features

Both `.flow.ts` and `.feature` files can live in the same `flowDir`. Spana discovers and runs both. Use whichever style fits the test -- Gherkin for behavior specs, flows for lower-level or exploratory tests.
