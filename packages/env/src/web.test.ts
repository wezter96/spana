import { describe, expect, test } from "bun:test";

let importCounter = 0;

async function importFreshWeb() {
  importCounter += 1;
  return import(new URL(`./web.ts?case=${importCounter}`, import.meta.url).href);
}

describe("web env", () => {
  test("creates an empty env object without requiring runtime variables", async () => {
    const { env } = await importFreshWeb();

    expect(env).toEqual({});
  });
});
