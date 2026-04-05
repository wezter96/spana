import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

let importCounter = 0;

async function importFreshNative(envValue: string) {
  const previous = process.env.EXPO_PUBLIC_SERVER_URL;
  process.env.EXPO_PUBLIC_SERVER_URL = envValue;
  importCounter += 1;

  try {
    return await import(new URL(`./native.ts?case=${importCounter}`, import.meta.url).href);
  } finally {
    if (previous === undefined) {
      delete process.env.EXPO_PUBLIC_SERVER_URL;
    } else {
      process.env.EXPO_PUBLIC_SERVER_URL = previous;
    }
  }
}

function runNativeImport(envValue?: string, assertion?: string) {
  const env = { ...process.env };
  if (envValue === undefined) {
    delete env.EXPO_PUBLIC_SERVER_URL;
  } else {
    env.EXPO_PUBLIC_SERVER_URL = envValue;
  }

  const script = `const { env } = await import(${JSON.stringify(new URL("./native.ts", import.meta.url).href)}); ${assertion ?? ""}`;

  const result = spawnSync("bun", ["-e", script], {
    env,
    encoding: "utf8",
  });

  return {
    exitCode: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr,
  };
}

describe("native env", () => {
  test("reads a valid Expo public server URL from runtime env", async () => {
    const { env } = await importFreshNative("https://example.com");

    expect(env.EXPO_PUBLIC_SERVER_URL).toBe("https://example.com");
  });

  test("fails when the required Expo public server URL is missing", () => {
    const result = runNativeImport();

    expect(result.exitCode).toBe(1);
  });

  test("treats empty strings as undefined during validation", () => {
    const result = runNativeImport("");

    expect(result.exitCode).toBe(1);
  });
});
