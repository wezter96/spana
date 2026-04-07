import { describe, expect, test } from "bun:test";
import { flow } from "./flow.js";

const fn = async () => {};

describe("flow", () => {
  test("supports the name + function overload", () => {
    const definition = flow("simple flow", fn);

    expect(definition).toEqual({
      name: "simple flow",
      fn,
      config: {},
    });
  });

  test("supports the name + config + function overload", () => {
    const config = { tags: ["smoke"], timeout: 5_000 };
    const definition = flow("configured flow", config, fn);

    expect(definition.name).toBe("configured flow");
    expect(definition.fn).toBe(fn);
    expect(definition.config).toBe(config);
  });

  test("accepts when.platform config", () => {
    const f = flow("ios only", { when: { platform: "ios" } }, async () => {});
    expect(f.config.when?.platform).toBe("ios");
  });

  test("accepts when.platform as array", () => {
    const f = flow("mobile only", { when: { platform: ["ios", "android"] } }, async () => {});
    expect(f.config.when?.platform).toEqual(["ios", "android"]);
  });

  test("accepts when.env config", () => {
    const f = flow("ci only", { when: { env: "CI" } }, async () => {});
    expect(f.config.when?.env).toBe("CI");
  });
});
