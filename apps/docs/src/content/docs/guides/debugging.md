---
title: Debugging
description: Debug failing tests interactively with the built-in REPL.
---

When a test fails, spana can drop you into an interactive REPL connected to the live device session. This lets you inspect the screen, try selectors, and experiment with actions before the session is torn down.

## Enabling the debug REPL

```bash
spana test --debug-on-failure
```

When a flow fails, instead of moving to the next flow, spana pauses and opens a REPL:

```
Entering debug REPL for failed flow "login flow" on android.
Available bindings: app, expect, driver, platform, flowName, error, hierarchy(), selectors(), help()
Use top-level await for async calls, for example: await app.tap({ text: "Login" })

spana:android>
```

## Available bindings

| Binding       | Type     | Description                                          |
| ------------- | -------- | ---------------------------------------------------- |
| `app`         | object   | Full `PromiseApp` API -- tap, inputText, scroll, etc |
| `expect`      | function | Assertion helper, same as in flows                   |
| `driver`      | object   | Raw driver service for low-level access              |
| `platform`    | string   | Current platform (`"web"`, `"android"`, `"ios"`)     |
| `flowName`    | string   | Name of the failed flow                              |
| `error`       | Error    | The error that caused the failure                    |
| `hierarchy()` | async    | Returns the parsed UI element tree                   |
| `selectors()` | async    | Returns suggested selectors for visible elements     |
| `help()`      | function | Print all available bindings                         |

## Example session

```
spana:android> error.message
'Timed out waiting for selector { testID: "welcome-text" }'

spana:android> await selectors()
[
  { suggestedSelector: { testID: 'login-button' }, elementType: 'Button', text: 'Sign In' },
  { suggestedSelector: { text: 'Welcome' }, elementType: 'Text', text: 'Welcome' },
  ...
]

spana:android> await app.tap({ text: "Sign In" })
undefined

spana:android> await expect({ testID: "welcome-text" }).toBeVisible()
undefined

spana:android> .exit
```

## Tips

- Use `await selectors()` to discover what's on screen -- this is the fastest way to find the right selector
- Use `await hierarchy()` for the full element tree with bounds, visibility, and nesting
- All `app` methods use auto-wait, so `await app.tap(...)` will retry until the element appears
- The REPL only activates once per test run (the first failure) to avoid blocking CI
- The REPL requires an interactive terminal (TTY) -- it's skipped automatically in CI environments
- Type `.exit` or press `Ctrl+D` to leave the REPL and continue the test run
