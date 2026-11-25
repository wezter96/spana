import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = { ...require("node:fs") } as typeof import("node:fs");

const netState = {
  execCalls: [] as Array<{ command: string; args: string[]; options?: Record<string, unknown> }>,
  execErrors: new Set<string>(),
};

function resetNetState(): void {
  netState.execCalls = [];
  netState.execErrors.clear();
}

let importCounter = 0;

function registerNetMocks(): void {
  mock.module("node:child_process", () => ({
    execSync: () => "",
    spawn: () => ({ unref: () => {}, kill: () => {} }),
    execFileSync: (command: string, args: string[], options?: Record<string, unknown>) => {
      const full = `${command} ${args.join(" ")}`;
      netState.execCalls.push({ command, args, options });
      if (netState.execErrors.has(full)) {
        throw new Error(`mock error: ${full}`);
      }
      return "";
    },
  }));

  mock.module("node:fs", () => ({
    ...realFs,
    readFileSync: realFs.readFileSync,
    unlinkSync: () => undefined,
  }));

  mock.module("../core/port-allocator.js", () => ({
    allocatePort: () => 8100,
    releasePort: () => {},
  }));
}

async function importFreshIOS() {
  importCounter += 1;
  return (await import(
    new URL(`./ios.ts?net=${importCounter}`, import.meta.url).href
  )) as typeof import("./ios.js");
}

describe("iOS network helpers (pfctl/dnctl)", () => {
  beforeEach(() => {
    mock.restore();
    resetNetState();
    registerNetMocks();
  });

  afterEach(() => {
    mock.restore();
  });

  test("SPANA_ANCHOR constant is correct", async () => {
    const ios = await importFreshIOS();
    expect(ios.SPANA_ANCHOR).toBe("com.spana.network");
  });

  test("pfctlSetOffline(true) blocks all traffic and enables pfctl", async () => {
    const ios = await importFreshIOS();
    ios.pfctlSetOffline(true);

    expect(netState.execCalls.map((c) => `${c.command} ${c.args.join(" ")}`)).toEqual([
      "sudo pfctl -a com.spana.network -f -",
      "sudo pfctl -e",
    ]);
    expect(netState.execCalls[0]?.options?.input).toBe("block out all\n");
  });

  test("pfctlSetOffline(true) ignores pfctl -e errors", async () => {
    netState.execErrors.add("sudo pfctl -e");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlSetOffline(true)).not.toThrow();
  });

  test("pfctlSetOffline(false) flushes anchor rules", async () => {
    const ios = await importFreshIOS();
    ios.pfctlSetOffline(false);

    expect(netState.execCalls.map((c) => `${c.command} ${c.args.join(" ")}`)).toEqual([
      "sudo pfctl -a com.spana.network -F all",
    ]);
  });

  test("pfctlSetOffline(false) ignores flush errors", async () => {
    netState.execErrors.add("sudo pfctl -a com.spana.network -F all");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlSetOffline(false)).not.toThrow();
  });

  test("pfctlSetThrottle configures dnctl pipe and dummynet rules", async () => {
    const ios = await importFreshIOS();
    ios.pfctlSetThrottle(500, 100);

    expect(netState.execCalls.map((c) => `${c.command} ${c.args.join(" ")}`)).toEqual([
      "sudo dnctl pipe 1 config bw 500Kbit/s delay 100ms",
      "sudo pfctl -a com.spana.network -f -",
      "sudo pfctl -e",
    ]);
    expect(netState.execCalls[1]?.options?.input).toBe("dummynet out all pipe 1\n");
  });

  test("pfctlSetThrottle ignores pfctl -e errors", async () => {
    netState.execErrors.add("sudo pfctl -e");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlSetThrottle(1000, 50)).not.toThrow();
  });

  test("pfctlResetNetwork flushes anchor rules and dnctl pipes", async () => {
    const ios = await importFreshIOS();
    ios.pfctlResetNetwork();

    expect(netState.execCalls.map((c) => `${c.command} ${c.args.join(" ")}`)).toEqual([
      "sudo pfctl -a com.spana.network -F all",
      "sudo dnctl -q flush",
    ]);
  });

  test("pfctlResetNetwork ignores all errors", async () => {
    netState.execErrors.add("sudo pfctl -a com.spana.network -F all");
    netState.execErrors.add("sudo dnctl -q flush");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlResetNetwork()).not.toThrow();
  });
});
