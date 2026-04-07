import { beforeEach, describe, expect, mock, test } from "bun:test";

const themeState: { theme: string | undefined } = {
  theme: "dark",
};

mock.module("next-themes", () => ({
  useTheme: () => themeState,
}));

function MockSonner() {
  return null;
}

mock.module("sonner", () => ({
  Toaster: MockSonner,
}));

let importCounter = 0;

async function importFreshToaster() {
  importCounter += 1;
  return import(new URL(`./sonner.tsx?case=${importCounter}`, import.meta.url).href);
}

describe("sonner wrapper", () => {
  beforeEach(() => {
    themeState.theme = "dark";
  });

  test("passes themed icons and styling tokens to Sonner", async () => {
    const { Toaster } = await importFreshToaster();
    const element = Toaster({ richColors: true });

    expect(element.props.theme).toBe("dark");
    expect(element.props.className).toBe("toaster group");
    expect(element.props.icons.success.props.className).toBe("size-4");
    expect(element.props.icons.loading.props.className).toContain("animate-spin");
    expect(element.props.toastOptions.classNames.toast).toBe("cn-toast");
    expect(element.props.style["--normal-bg"]).toBe("var(--popover)");
    expect(element.props.style["--normal-border"]).toBe("var(--border)");
    expect(element.props.richColors).toBe(true);
  });

  test("falls back to the system theme when the hook does not provide one", async () => {
    themeState.theme = undefined;

    const { Toaster } = await importFreshToaster();
    const element = Toaster({});

    expect(element.props.theme).toBe("system");
  });
});
