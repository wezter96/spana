import { describe, it, expect } from "bun:test";
import { classifyError } from "./classify-error.js";

describe("classifyError", () => {
  it("classifies ElementNotFoundError by tag", () => {
    const error = Object.assign(new Error("not found"), {
      _tag: "ElementNotFoundError",
      selector: { testID: "login-btn" },
      timeoutMs: 5000,
    });
    const result = classifyError(error);
    expect(result.category).toBe("element-not-found");
    expect(result.suggestion).toContain('testID="login-btn"');
    expect(result.suggestion).toContain("spana selectors");
  });

  it("classifies WaitTimeoutError by tag", () => {
    const error = Object.assign(new Error("wait timeout"), {
      _tag: "WaitTimeoutError",
      selector: { text: "Welcome" },
      timeoutMs: 3000,
    });
    const result = classifyError(error);
    expect(result.category).toBe("element-not-found");
    expect(result.suggestion).toContain('text="Welcome"');
  });

  it("classifies TextMismatchError by tag", () => {
    const error = Object.assign(new Error("mismatch"), {
      _tag: "TextMismatchError",
      expected: "Hello",
      actual: "Goodbye",
      selector: { testID: "title" },
    });
    const result = classifyError(error);
    expect(result.category).toBe("text-mismatch");
    expect(result.suggestion).toContain('"Hello"');
    expect(result.suggestion).toContain('"Goodbye"');
  });

  it("classifies DeviceDisconnectedError by tag", () => {
    const error = Object.assign(new Error("lost"), {
      _tag: "DeviceDisconnectedError",
      deviceId: "emulator-5554",
    });
    const result = classifyError(error);
    expect(result.category).toBe("device-disconnected");
    expect(result.suggestion).toContain("emulator-5554");
  });

  it("classifies AppCrashedError by tag", () => {
    const error = Object.assign(new Error("crash"), {
      _tag: "AppCrashedError",
      appId: "com.example.app",
    });
    const result = classifyError(error);
    expect(result.category).toBe("app-crashed");
    expect(result.suggestion).toContain("com.example.app");
  });

  it("classifies AppNotInstalledError by tag", () => {
    const error = Object.assign(new Error("not installed"), {
      _tag: "AppNotInstalledError",
      appId: "com.example.app",
    });
    const result = classifyError(error);
    expect(result.category).toBe("app-not-installed");
    expect(result.suggestion).toContain("com.example.app");
  });

  it("classifies DriverError by tag", () => {
    const error = Object.assign(new Error("driver fail"), {
      _tag: "DriverError",
      command: "tap",
    });
    const result = classifyError(error);
    expect(result.category).toBe("driver-error");
    expect(result.suggestion).toContain('"tap"');
  });

  it("classifies ConfigError by tag", () => {
    const error = Object.assign(new Error("bad config"), { _tag: "ConfigError" });
    const result = classifyError(error);
    expect(result.category).toBe("config-error");
    expect(result.suggestion).toContain("validate-config");
  });

  it("falls back to heuristic for timeout messages", () => {
    const result = classifyError(new Error("Operation timed out after 5000ms"));
    expect(result.category).toBe("timeout");
    expect(result.suggestion).toContain("waitTimeout");
  });

  it("falls back to heuristic for not found messages", () => {
    const result = classifyError(new Error("Element not found"));
    expect(result.category).toBe("element-not-found");
    expect(result.suggestion).toContain("spana selectors");
  });

  it("falls back to heuristic for connection errors", () => {
    const result = classifyError(new Error("ECONNREFUSED 127.0.0.1:4723"));
    expect(result.category).toBe("device-disconnected");
  });

  it("returns unknown for unrecognized errors", () => {
    const result = classifyError(new Error("something unexpected"));
    expect(result.category).toBe("unknown");
    expect(result.suggestion).toBeUndefined();
  });
});
