import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const realFs = { ...require("node:fs") } as typeof import("node:fs");

const netState = {
  execSyncCalls: [] as Array<{ command: string; options?: unknown }>,
  execSyncErrors: new Set<string>(),
};

function resetNetState(): void {
  netState.execSyncCalls = [];
  netState.execSyncErrors.clear();
}

let importCounter = 0;

function registerNetMocks(): void {
  mock.module("node:child_process", () => ({
    execSync: (command: string, options?: unknown) => {
      netState.execSyncCalls.push({ command, options });
      if (netState.execSyncErrors.has(command)) {
        throw new Error(`mock error: ${command}`);
      }
      return "";
    },
    execFileSync: () => "",
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

    const commands = netState.execSyncCalls.map((c) => c.command);
    expect(commands).toEqual([
      'echo "block out all\n" | sudo pfctl -a com.spana.network -f -',
      "sudo pfctl -e 2>/dev/null",
    ]);
  });

  test("pfctlSetOffline(true) ignores pfctl -e errors", async () => {
    netState.execSyncErrors.add("sudo pfctl -e 2>/dev/null");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlSetOffline(true)).not.toThrow();
  });

  test("pfctlSetOffline(false) flushes anchor rules", async () => {
    const ios = await importFreshIOS();
    ios.pfctlSetOffline(false);

    const commands = netState.execSyncCalls.map((c) => c.command);
    expect(commands).toEqual(["sudo pfctl -a com.spana.network -F all"]);
  });

  test("pfctlSetOffline(false) ignores flush errors", async () => {
    netState.execSyncErrors.add("sudo pfctl -a com.spana.network -F all");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlSetOffline(false)).not.toThrow();
  });

  test("pfctlSetThrottle configures dnctl pipe and dummynet rules", async () => {
    const ios = await importFreshIOS();
    ios.pfctlSetThrottle(500, 100);

    const commands = netState.execSyncCalls.map((c) => c.command);
    expect(commands).toEqual([
      "sudo dnctl pipe 1 config bw 500Kbit/s delay 100ms",
      'echo "dummynet out all pipe 1\n" | sudo pfctl -a com.spana.network -f -',
      "sudo pfctl -e 2>/dev/null",
    ]);
  });

  test("pfctlSetThrottle ignores pfctl -e errors", async () => {
    netState.execSyncErrors.add("sudo pfctl -e 2>/dev/null");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlSetThrottle(1000, 50)).not.toThrow();
  });

  test("pfctlResetNetwork flushes anchor rules and dnctl pipes", async () => {
    const ios = await importFreshIOS();
    ios.pfctlResetNetwork();

    const commands = netState.execSyncCalls.map((c) => c.command);
    expect(commands).toEqual(["sudo pfctl -a com.spana.network -F all", "sudo dnctl -q flush"]);
  });

  test("pfctlResetNetwork ignores all errors", async () => {
    netState.execSyncErrors.add("sudo pfctl -a com.spana.network -F all");
    netState.execSyncErrors.add("sudo dnctl -q flush");
    const ios = await importFreshIOS();
    expect(() => ios.pfctlResetNetwork()).not.toThrow();
  });
});
