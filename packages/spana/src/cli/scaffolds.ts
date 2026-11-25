const INIT_PRESETS = [
  "local-web",
  "local-react-native",
  "capacitor-web-first",
  "browserstack",
  "saucelabs",
] as const;
const FLOW_STUB_PRESETS = ["blank", "smoke", "auth"] as const;

export type InitPreset = (typeof INIT_PRESETS)[number];
export type FlowStubPreset = (typeof FLOW_STUB_PRESETS)[number];

export function isInitPreset(value: string): value is InitPreset {
  return (INIT_PRESETS as readonly string[]).includes(value);
}

export function isFlowStubPreset(value: string): value is FlowStubPreset {
  return (FLOW_STUB_PRESETS as readonly string[]).includes(value);
}

export function generateFlowStub(
  name: string,
  opts: { platforms?: string[]; tags?: string[]; preset?: FlowStubPreset },
): string {
  const preset = opts.preset ?? "smoke";
  const platforms = opts.platforms && opts.platforms.length > 0 ? opts.platforms : undefined;
  const tags = opts.tags && opts.tags.length > 0 ? opts.tags : ["smoke"];

  const configParts: string[] = [];
  configParts.push(`tags: [${tags.map((t) => `"${t}"`).join(", ")}]`);
  if (platforms) {
    configParts.push(`platforms: [${platforms.map((p) => `"${p}"`).join(", ")}]`);
  }
  const configStr = `{ ${configParts.join(", ")} }`;

  if (preset === "blank") {
    return `import { flow } from "spana";

export default flow(
  "${name}",
  ${configStr},
  async ({ app, expect }) => {
    // Write your test flow here.
    // Run "spana selectors --platform web" to discover available selectors.
  },
);
`;
  }

  if (preset === "auth") {
    return `import { flow } from "spana";

export default flow(
  "${name}",
  ${configStr},
  async ({ app, expect, platform }) => {
    // Navigate to login screen
    await expect({ testID: "login-email-input" }).toBeVisible();

    // Enter credentials
    await app.tap({ testID: "login-email-input" });
    await app.inputText("user@example.com");
    await app.dismissKeyboard();

    await app.tap({ testID: "login-password-input" });
    await app.inputText("password123");
    await app.dismissKeyboard();

    // Submit
    await app.tap({ testID: "login-submit-button" });

    // Verify logged in
    await expect({ testID: "home-screen" }).toBeVisible({ timeout: 10_000 });
  },
);
`;
  }

  // Default: "smoke"
  return `import { flow } from "spana";

export default flow(
  "${name}",
  ${configStr},
  async ({ app, expect }) => {
    // Verify the app loads and the main screen is visible.
    // Replace with a selector from your app — run "spana selectors" to discover them.
    await expect({ testID: "main-screen" }).toBeVisible({ timeout: 10_000 });
  },
);
`;
}
