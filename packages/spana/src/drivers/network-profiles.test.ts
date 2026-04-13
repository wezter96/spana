import { describe, expect, test } from "bun:test";
import { resolveNetworkConditions } from "./network-profiles.js";
import type { NetworkConditions } from "./raw-driver.js";

describe("resolveNetworkConditions", () => {
  test("resolves wifi profile", () => {
    const result = resolveNetworkConditions({ profile: "wifi" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 2,
      downloadThroughputKbps: 30000,
      uploadThroughputKbps: 15000,
    });
  });

  test("resolves 4g profile", () => {
    const result = resolveNetworkConditions({ profile: "4g" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 20,
      downloadThroughputKbps: 20000,
      uploadThroughputKbps: 10000,
    });
  });

  test("resolves 3g profile", () => {
    const result = resolveNetworkConditions({ profile: "3g" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 100,
      downloadThroughputKbps: 1500,
      uploadThroughputKbps: 750,
    });
  });

  test("resolves 2g profile", () => {
    const result = resolveNetworkConditions({ profile: "2g" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 300,
      downloadThroughputKbps: 280,
      uploadThroughputKbps: 256,
    });
  });

  test("resolves edge profile", () => {
    const result = resolveNetworkConditions({ profile: "edge" });
    expect(result).toEqual({
      offline: false,
      latencyMs: 400,
      downloadThroughputKbps: 240,
      uploadThroughputKbps: 200,
    });
  });

  test("resolves offline profile", () => {
    const result = resolveNetworkConditions({ profile: "offline" });
    expect(result).toEqual({
      offline: true,
      latencyMs: 0,
      downloadThroughputKbps: 0,
      uploadThroughputKbps: 0,
    });
  });

  test("uses custom values when no profile", () => {
    const conditions: NetworkConditions = {
      offline: false,
      latencyMs: 50,
      downloadThroughputKbps: 5000,
      uploadThroughputKbps: 2500,
    };
    const result = resolveNetworkConditions(conditions);
    expect(result).toEqual({
      offline: false,
      latencyMs: 50,
      downloadThroughputKbps: 5000,
      uploadThroughputKbps: 2500,
    });
  });

  test("profile takes precedence over custom values", () => {
    const conditions: NetworkConditions = {
      profile: "wifi",
      latencyMs: 999,
      downloadThroughputKbps: 999,
      uploadThroughputKbps: 999,
    };
    const result = resolveNetworkConditions(conditions);
    expect(result).toEqual({
      offline: false,
      latencyMs: 2,
      downloadThroughputKbps: 30000,
      uploadThroughputKbps: 15000,
    });
  });

  test("defaults when only offline specified", () => {
    const result = resolveNetworkConditions({ offline: true });
    expect(result).toEqual({
      offline: true,
      latencyMs: 0,
      downloadThroughputKbps: -1,
      uploadThroughputKbps: -1,
    });
  });

  test("empty object resets to defaults", () => {
    const result = resolveNetworkConditions({});
    expect(result).toEqual({
      offline: false,
      latencyMs: 0,
      downloadThroughputKbps: -1,
      uploadThroughputKbps: -1,
    });
  });
});
