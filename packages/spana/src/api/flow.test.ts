import { describe, expect, test } from "bun:test";
import { flow } from "./flow.js";

describe("flow", () => {
  test("supports the name + function overload", () => {
    const fn = async () => {};
    const definition = flow("simple flow", fn);

    expect(definition).toEqual({
      name: "simple flow",
      fn,
      config: {},
    });
  });

  test("supports the name + config + function overload", () => {
    const fn = async () => {};
    const config = { tags: ["smoke"], timeout: 5_000 };
    const definition = flow("configured flow", config, fn);

    expect(definition.name).toBe("configured flow");
    expect(definition.fn).toBe(fn);
    expect(definition.config).toBe(config);
  });
});
