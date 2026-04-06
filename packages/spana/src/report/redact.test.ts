import { describe, it, expect } from "bun:test";
import { createRedactor, registerUrlSecrets } from "./redact.js";

describe("createRedactor", () => {
  it("redacts URL credentials", () => {
    const r = createRedactor({ redactEnv: false });
    expect(r.redact("https://myuser:s3cret@hub-cloud.browserstack.com/wd/hub")).toBe(
      "https://***@hub-cloud.browserstack.com/wd/hub",
    );
  });

  it("redacts credentials in http URLs", () => {
    const r = createRedactor({ redactEnv: false });
    expect(r.redact("http://admin:password123@localhost:4723")).toBe("http://***@localhost:4723");
  });

  it("redacts Basic auth tokens", () => {
    const r = createRedactor({ redactEnv: false });
    expect(r.redact("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: Basic ***");
  });

  it("redacts Bearer tokens", () => {
    const r = createRedactor({ redactEnv: false });
    expect(r.redact("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature")).toBe(
      "Authorization: Bearer ***",
    );
  });

  it("redacts values after common key names", () => {
    const r = createRedactor({ redactEnv: false });
    expect(r.redact("apiKey=abcdef1234567890")).toBe("apiKey=***");
    expect(r.redact('access_key: "ABCDEFGHIJKLMNOP"')).toBe('access_key: "***"');
  });

  it("redacts literal secrets added via addSecret", () => {
    const r = createRedactor({ redactEnv: false });
    r.addSecret("my-super-secret-key");
    expect(r.redact("The key is my-super-secret-key here")).toBe("The key is *** here");
  });

  it("ignores short secrets in addSecret", () => {
    const r = createRedactor({ redactEnv: false });
    r.addSecret("short");
    expect(r.redact("short value")).toBe("short value");
  });

  it("redacts custom patterns", () => {
    const r = createRedactor({
      redactEnv: false,
      patterns: [/sk-[a-zA-Z0-9]{20,}/g],
    });
    expect(r.redact("key: sk-abcdefghijklmnopqrstuvwxyz")).toBe("key: ***");
  });

  it("redacts custom literal strings", () => {
    const r = createRedactor({
      redactEnv: false,
      literals: ["my-hardcoded-secret"],
    });
    expect(r.redact("url contains my-hardcoded-secret in path")).toBe("url contains *** in path");
  });

  it("returns input unchanged when disabled", () => {
    const r = createRedactor({ disabled: true });
    expect(r.redact("https://user:pass@host.com")).toBe("https://user:pass@host.com");
  });

  it("leaves non-sensitive content alone", () => {
    const r = createRedactor({ redactEnv: false });
    const msg = 'Element not found within 5000ms — selector: { testID: "login-btn" }';
    expect(r.redact(msg)).toBe(msg);
  });
});

describe("registerUrlSecrets", () => {
  it("registers username and password from URL", () => {
    const r = createRedactor({ redactEnv: false });
    registerUrlSecrets(r, "https://myuser99:xK9mP2qR@hub.browserstack.com/wd/hub");
    expect(r.redact("user is myuser99 with key xK9mP2qR")).toBe("user is *** with key ***");
  });

  it("handles URL-encoded credentials", () => {
    const r = createRedactor({ redactEnv: false });
    registerUrlSecrets(r, "https://user%40domain:p%40ss@host.com");
    expect(r.redact("login as user@domain with p@ss")).toBe("login as *** with ***");
  });

  it("handles URLs without credentials gracefully", () => {
    const r = createRedactor({ redactEnv: false });
    registerUrlSecrets(r, "http://localhost:4723");
    expect(r.redact("http://localhost:4723")).toBe("http://localhost:4723");
  });

  it("handles invalid URLs gracefully", () => {
    const r = createRedactor({ redactEnv: false });
    registerUrlSecrets(r, "not a url");
    expect(r.redact("not a url")).toBe("not a url");
  });
});
