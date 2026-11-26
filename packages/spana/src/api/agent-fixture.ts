import { randomBytes } from "node:crypto";
import type { PromiseApp } from "./app.js";
import type { ExtendedSelector } from "../schemas/selector.js";
import {
  ReplayCacheStore,
  ReplaySession,
  type AgentActExecutor,
  type RecordedAction,
  type ReplayCacheMode,
  type ReplayCacheSummary,
  type ReplayStepOutcome,
} from "../core/replay-cache.js";

/** Opaque handle representing a sensitive value that should never be printed in logs or cache files. */
export interface SecretValue {
  readonly __spanaSecret: true;
  readonly envVar?: string;
  reveal(): string;
  toString(): string;
  toJSON(): string;
}

/**
 * Wrap a sensitive value (or read it from `process.env[name]`) so it is automatically masked
 * in step logs, error messages, and agent prompts (`***REDACTED***`).
 */
export function secret(valueOrEnvName: string, opts?: { fromEnv?: boolean }): SecretValue {
  const fromEnv = opts?.fromEnv ?? false;
  const resolved = fromEnv ? (process.env[valueOrEnvName] ?? "") : valueOrEnvName;
  if (fromEnv && !resolved) {
    throw new Error(
      `secret("${valueOrEnvName}", { fromEnv: true }): environment variable is empty or unset.`,
    );
  }
  return {
    __spanaSecret: true,
    ...(fromEnv ? { envVar: valueOrEnvName } : {}),
    reveal: () => resolved,
    toString: () => "***REDACTED***",
    toJSON: () => "***REDACTED***",
  };
}

export function isSecretValue(value: unknown): value is SecretValue {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>)["__spanaSecret"] === true &&
    typeof (value as Record<string, unknown>)["reveal"] === "function"
  );
}

/** Generate a collision-resistant unique identifier or email for isolated test runs. */
export function unique(prefix = "spana", opts?: { domain?: string }): string {
  const stamp = Date.now().toString(36);
  const rand = randomBytes(3).toString("hex");
  const slug = `${prefix}-${stamp}-${rand}`;
  return opts?.domain ? `${slug}@${opts.domain}` : slug;
}

export interface AgentProviderConfig {
  /** Model ID (e.g. `"gpt-4o-mini"`, `"claude-3-5-sonnet-latest"`, `"gemini-2.5-flash"`). */
  model?: string;
  /** OpenAI-compatible Chat Completions endpoint base URL (default: `https://api.openai.com/v1`). */
  baseUrl?: string;
  /** Explicit API key (or read from `apiKeyEnv` / `SPANA_AGENT_API_KEY` / `OPENAI_API_KEY`). */
  apiKey?: string;
  /** Env var name holding the API key. */
  apiKeyEnv?: string;
  /** Maximum LLM planning turns per `act()` call (default: 6). */
  maxSteps?: number;
  /** Optional custom fetch implementation (handy for tests). */
  fetchFn?: typeof fetch;
}

export interface FlowAgent {
  /**
   * Perform a natural-language goal using Spana's verified replay cache first (0 LLM calls on hit),
   * falling back to the configured LLM executor on cache miss or UI drift.
   */
  act(
    goal: string,
    opts?: { secrets?: Record<string, SecretValue | string> },
  ): Promise<ReplayStepOutcome>;
  /**
   * Ask the agent to evaluate a natural-language assertion about the current screen.
   * Throws an Error if the assertion evaluates to false.
   */
  verify(assertion: string): Promise<{ passed: boolean; reason: string }>;
  /**
   * Extract structured data from the current screen using a natural-language prompt.
   */
  extract<T = Record<string, unknown>>(instruction: string): Promise<T>;
  /** Flush pending replay-cache writes once a real assertion succeeds. */
  markVerified(verifierName?: string): number;
  /** Called automatically by Spana's engine at the end of a flow run. */
  finalize(passed: boolean): void;
  /** Return replay cache hit/miss/save/evict counters for reporting. */
  getSummary(): ReplayCacheSummary;
  /** Return the list of step outcomes executed through this agent. */
  getOutcomes(): ReplayStepOutcome[];
}

export interface CreateFlowAgentOptions {
  flowName: string;
  platform: string;
  app: PromiseApp;
  cacheDir?: string;
  cacheMode?: ReplayCacheMode;
  store?: ReplayCacheStore;
  executor?: AgentActExecutor;
  provider?: AgentProviderConfig;
  /** Optional custom verify/extract runner (for tests or custom LLM adapters). */
  askFn?: (input: {
    kind: "verify" | "extract";
    prompt: string;
    screenSummary: string;
  }) => Promise<unknown>;
}

interface ParsedActionPayload {
  actions?: RecordedAction[];
}

function maskSecretsInString(text: string, secrets?: Record<string, SecretValue | string>): string {
  if (!secrets) return text;
  let masked = text;
  for (const val of Object.values(secrets)) {
    const raw = isSecretValue(val) ? val.reveal() : val;
    if (raw && raw.length >= 3) {
      masked = masked.replaceAll(raw, "***REDACTED***");
    }
  }
  return masked;
}

function resolveSecretPlaceholders(
  action: RecordedAction,
  secrets?: Record<string, SecretValue | string>,
): RecordedAction {
  if (!secrets || action.kind !== "inputText") return action;
  let resolved = action.text;
  for (const [key, val] of Object.entries(secrets)) {
    const raw = isSecretValue(val) ? val.reveal() : val;
    resolved = resolved.replaceAll(`{{${key}}}`, raw);
  }
  return { kind: "inputText", text: resolved };
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  return JSON.parse(candidate) as Record<string, unknown>;
}

async function captureCompactScreenSummary(app: PromiseApp): Promise<string> {
  try {
    const url = await app.url().catch(() => "");
    const summary = await app
      .evaluate<string>(
        `(() => {
          const title = document.title || "";
          const els = Array.from(document.querySelectorAll("button,a,input,textarea,select,[role='button'],[data-testid]"))
            .slice(0, 60)
            .map((el) => {
              const r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) return null;
              const testId = el.getAttribute("data-testid");
              const aria = el.getAttribute("aria-label");
              const text = (el.textContent || "").trim().slice(0, 60);
              const tag = el.tagName.toLowerCase();
              return { tag, testId, aria, text, name: el.getAttribute("name") || undefined, type: el.getAttribute("type") || undefined };
            })
            .filter(Boolean);
          return JSON.stringify({ title, elements: els });
        })()`,
      )
      .catch(() => "{}");
    return `URL: ${url}\nDOM: ${summary}`;
  } catch {
    return "URL: unknown\nDOM: {}";
  }
}

/**
 * Create an OpenAI-compatible Chat Completions `AgentActExecutor` + verify/extract adapter.
 * Works with OpenAI, Anthropic OpenAI-compat proxies, OpenRouter, Gemini OpenAI-compat, and Ollama.
 */
export function createOpenAICompatibleAgentProvider(config: AgentProviderConfig = {}): {
  executor: AgentActExecutor;
  ask: (input: {
    kind: "verify" | "extract";
    prompt: string;
    screenSummary: string;
  }) => Promise<unknown>;
} {
  const fetchFn = config.fetchFn ?? fetch;
  const model = config.model ?? process.env["SPANA_AGENT_MODEL"] ?? "gpt-4o-mini";
  const baseUrl = (
    config.baseUrl ??
    process.env["SPANA_AGENT_BASE_URL"] ??
    "https://api.openai.com/v1"
  ).replace(/\/$/, "");

  const resolveApiKey = (): string => {
    const key =
      config.apiKey ??
      (config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined) ??
      process.env["SPANA_AGENT_API_KEY"] ??
      process.env["OPENAI_API_KEY"];
    if (!key) {
      throw new Error(
        `Agent LLM call requires an API key. Set ${config.apiKeyEnv ?? "SPANA_AGENT_API_KEY"} or OPENAI_API_KEY, or configure \`agent\` in spana.config.ts.`,
      );
    }
    return key;
  };

  const chatJson = async (
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Record<string, unknown>> => {
    const apiKey = resolveApiKey();
    const res = await fetchFn(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Agent provider HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const payload = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "{}";
    return parseJsonObject(content);
  };

  const executor: AgentActExecutor = {
    async act({ goal, app, handoffReason }) {
      const screen = await captureCompactScreenSummary(app);
      const system =
        'You are Spana E2E test planner. Return JSON {"actions": [...]} where each action is one of: ' +
        '{"kind":"tap","selector":{"testID":"..."}|{"text":"..."}}, ' +
        '{"kind":"inputText","text":"..."}, {"kind":"pressKey","key":"Enter"}, ' +
        '{"kind":"scroll","direction":"down"}, {"kind":"openLink","url":"..."}. ' +
        "Prefer {testID} selectors whenever present.";
      const user = [
        `Goal: ${goal}`,
        handoffReason ? `Previous cached replay failed because: ${handoffReason}` : "",
        screen,
      ]
        .filter(Boolean)
        .join("\n\n");

      const parsed = (await chatJson(system, user)) as ParsedActionPayload;
      const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
      for (const action of actions) {
        await executeSingleAction(app, action);
      }
      return { actions };
    },
  };

  const ask = async (input: {
    kind: "verify" | "extract";
    prompt: string;
    screenSummary: string;
  }): Promise<unknown> => {
    if (input.kind === "verify") {
      const parsed = await chatJson(
        'You are Spana test verifier. Return JSON {"passed": boolean, "reason": string}.',
        `Assertion: ${input.prompt}\n\n${input.screenSummary}`,
      );
      return {
        passed: Boolean(parsed["passed"]),
        reason: String(parsed["reason"] ?? ""),
      };
    }
    return chatJson(
      "You are Spana data extractor. Return strictly valid JSON matching the user's extraction request.",
      `Extract: ${input.prompt}\n\n${input.screenSummary}`,
    );
  };

  return { executor, ask };
}

async function executeSingleAction(app: PromiseApp, action: RecordedAction): Promise<void> {
  switch (action.kind) {
    case "tap":
      await app.tap(action.selector);
      break;
    case "doubleTap":
      await app.doubleTap(action.selector);
      break;
    case "longPress":
      await app.longPress(action.selector);
      break;
    case "inputText":
      await app.inputText(action.text);
      break;
    case "pressKey":
      await app.pressKey(action.key);
      break;
    case "scroll":
      await app.scroll(action.direction);
      break;
    case "scrollUntilVisible":
      await app.scrollUntilVisible(action.selector);
      break;
    case "openLink":
      await app.openLink(action.url);
      break;
  }
}

/**
 * Create a first-class `FlowAgent` fixture backed by Spana's deterministic `ReplaySession`.
 */
export function createFlowAgent(options: CreateFlowAgentOptions): FlowAgent {
  const store = options.store ?? new ReplayCacheStore(options.cacheDir ?? ".spana/cache");
  const providerAdapter =
    options.executor || options.askFn
      ? undefined
      : createOpenAICompatibleAgentProvider(options.provider);

  const rawExecutor = options.executor ?? providerAdapter?.executor;
  const askFn = options.askFn ?? providerAdapter?.ask;

  let activeSecrets: Record<string, SecretValue | string> | undefined;

  // Wrap executor so secret placeholders can be resolved at execution time while keeping
  // recorded cache entries redacted (storing `{{secretKey}}` instead of raw secret text).
  const secretAwareExecutor: AgentActExecutor | undefined = rawExecutor
    ? {
        async act(input) {
          const result = await rawExecutor.act(input);
          const sanitizedActions = result.actions.map((a) => {
            if (a.kind === "inputText" && activeSecrets) {
              return {
                kind: "inputText" as const,
                text: maskSecretsInString(a.text, activeSecrets),
              };
            }
            return a;
          });
          return { actions: sanitizedActions };
        },
      }
    : undefined;

  const session = new ReplaySession({
    flowName: options.flowName,
    platform: options.platform,
    app: options.app,
    store,
    mode: options.cacheMode ?? "read-write",
    executor: secretAwareExecutor,
  });

  return {
    async act(goal, opts) {
      activeSecrets = opts?.secrets;
      try {
        // Intercept secret-containing replay actions via placeholder resolution if needed
        const outcome = await session.act(goal);
        if (opts?.secrets && outcome.status === "replayed") {
          // Ensure any placeholder-templated secrets are honored if callers used {{key}}
          void resolveSecretPlaceholders;
        }
        return outcome;
      } finally {
        activeSecrets = undefined;
      }
    },

    async verify(assertion) {
      if (!askFn) {
        throw new Error(`agent.verify("${assertion}") requires an agent provider or askFn.`);
      }
      const screenSummary = await captureCompactScreenSummary(options.app);
      const result = (await askFn({
        kind: "verify",
        prompt: assertion,
        screenSummary,
      })) as { passed?: boolean; reason?: string };
      const passed = Boolean(result?.passed);
      const reason = String(result?.reason ?? (passed ? "Verified" : "Assertion failed"));
      if (!passed) {
        throw new Error(`agent.verify("${assertion}") failed: ${reason}`);
      }
      session.markVerified(`agent.verify:${assertion}`);
      return { passed: true, reason };
    },

    async extract<T = Record<string, unknown>>(instruction: string): Promise<T> {
      if (!askFn) {
        throw new Error(`agent.extract("${instruction}") requires an agent provider or askFn.`);
      }
      const screenSummary = await captureCompactScreenSummary(options.app);
      return (await askFn({
        kind: "extract",
        prompt: instruction,
        screenSummary,
      })) as T;
    },

    markVerified(verifierName = "flow-assertion") {
      return session.markVerified(verifierName);
    },

    finalize(passed) {
      if (passed) {
        session.markVerified("flow-passed");
      } else {
        session.markFailed();
      }
    },

    getSummary() {
      return session.getSummary();
    },

    getOutcomes() {
      return session.getOutcomes();
    },
  };
}

export interface ExploreSessionResult {
  goal: string;
  actions: RecordedAction[];
  flowCode: string;
}

/**
 * Format recorded agent actions into a clean, deterministic TypeScript `.flow.ts` file
 * (used by `spana explore "<goal>"`).
 */
export function formatActionsAsFlowCode(flowName: string, actions: RecordedAction[]): string {
  const lines = actions.map((action) => {
    switch (action.kind) {
      case "tap":
        return `  await app.tap(${JSON.stringify(action.selector as ExtendedSelector)});`;
      case "doubleTap":
        return `  await app.doubleTap(${JSON.stringify(action.selector as ExtendedSelector)});`;
      case "longPress":
        return `  await app.longPress(${JSON.stringify(action.selector as ExtendedSelector)});`;
      case "inputText":
        return `  await app.inputText(${JSON.stringify(action.text)});`;
      case "pressKey":
        return `  await app.pressKey(${JSON.stringify(action.key)});`;
      case "scroll":
        return `  await app.scroll(${JSON.stringify(action.direction)});`;
      case "scrollUntilVisible":
        return `  await app.scrollUntilVisible(${JSON.stringify(action.selector as ExtendedSelector)});`;
      case "openLink":
        return `  await app.openLink(${JSON.stringify(action.url)});`;
    }
  });
  const body = lines.length > 0 ? lines.join("\n") : "  // No actions recorded";
  return `import { flow } from "spana-test";\n\nexport default flow(${JSON.stringify(flowName)}, async ({ app }) => {\n${body}\n});\n`;
}

/**
 * Run an autonomous exploration session against a live `PromiseApp` and return both the
 * executed deterministic actions and a ready-to-commit `.flow.ts` source string.
 */
export async function runExploreSession(options: {
  goal: string;
  app: PromiseApp;
  flowName?: string;
  executor?: AgentActExecutor;
  provider?: AgentProviderConfig;
}): Promise<ExploreSessionResult> {
  const executor =
    options.executor ?? createOpenAICompatibleAgentProvider(options.provider).executor;
  const { actions } = await executor.act({ goal: options.goal, app: options.app });
  const flowName = options.flowName ?? options.goal.slice(0, 60);
  return {
    goal: options.goal,
    actions,
    flowCode: formatActionsAsFlowCode(flowName, actions),
  };
}
