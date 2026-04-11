import { Parser, AstBuilder, GherkinClassicTokenMatcher } from "@cucumber/gherkin";
import { IdGenerator } from "@cucumber/messages";
import type { FlowDefinition, FlowConfig } from "../api/flow.js";
import type { Platform } from "../schemas/selector.js";
import type { ScenarioStepResult, ScenarioStepKeyword } from "../report/types.js";
import { createStepMatcher, type MatchResult } from "./matcher.js";
import { globalRegistry, type StepContext } from "./registry.js";
import { getWorldFactory } from "./world.js";

const PLATFORM_TAGS: Record<string, Platform> = {
  "@web": "web",
  "@android": "android",
  "@ios": "ios",
};

interface GherkinStep {
  keyword: string;
  text: string;
  dataTable?: { rows: readonly { cells: readonly { value: string }[] }[] };
  docString?: { content: string; mediaType?: string };
}

interface GherkinScenario {
  name: string;
  tags: readonly { name: string }[];
  steps: readonly GherkinStep[];
  examples: readonly {
    tags: readonly { name: string }[];
    tableHeader?: { cells: readonly { value: string }[] };
    tableBody?: readonly { cells: readonly { value: string }[] }[];
  }[];
}

export function compileFeature(source: string, filePath?: string): FlowDefinition[] {
  const parser = new Parser(new AstBuilder(IdGenerator.uuid()), new GherkinClassicTokenMatcher());

  const document = parser.parse(source);
  const feature = document.feature;
  if (!feature) return [];

  const featureTags = feature.tags.map((t: { name: string }) => t.name);
  const flows: FlowDefinition[] = [];

  // Find background steps if any
  let backgroundSteps: readonly GherkinStep[] = [];
  for (const child of feature.children) {
    if (child.background) {
      backgroundSteps = child.background.steps as readonly GherkinStep[];
    }
  }

  for (const child of feature.children) {
    if (!child.scenario) continue;
    const scenario = child.scenario as unknown as GherkinScenario;

    if (scenario.examples.length > 0) {
      // Scenario Outline — expand each example row
      for (const example of scenario.examples) {
        if (!example.tableHeader || !example.tableBody) continue;
        const headers = example.tableHeader.cells.map((c) => c.value);
        const exampleTags = example.tags.map((t) => t.name);

        for (const row of example.tableBody) {
          const values = row.cells.map((c) => c.value);
          const replacements: Record<string, string> = {};
          for (let i = 0; i < headers.length; i++) {
            replacements[headers[i]!] = values[i] ?? "";
          }

          const expandedName = replaceOutlinePlaceholders(scenario.name, replacements);
          const expandedSteps = scenario.steps.map((s) => ({
            ...s,
            text: replaceOutlinePlaceholders(s.text, replacements),
          }));

          const allTags = [...featureTags, ...scenario.tags.map((t) => t.name), ...exampleTags];
          flows.push(
            buildFlowDefinition(
              `${feature.name} — ${expandedName}`,
              allTags,
              backgroundSteps,
              expandedSteps,
              filePath,
            ),
          );
        }
      }
    } else {
      // Regular Scenario
      const allTags = [...featureTags, ...scenario.tags.map((t) => t.name)];
      flows.push(
        buildFlowDefinition(
          `${feature.name} — ${scenario.name}`,
          allTags,
          backgroundSteps,
          scenario.steps,
          filePath,
        ),
      );
    }
  }

  return flows;
}

function buildFlowDefinition(
  name: string,
  tags: string[],
  backgroundSteps: readonly GherkinStep[],
  scenarioSteps: readonly GherkinStep[],
  filePath?: string,
): FlowDefinition {
  const { platforms, timeout, filteredTags } = extractFlowTags(tags);

  const config: FlowConfig = {
    tags: filteredTags.length > 0 ? filteredTags : undefined,
    platforms: platforms.length > 0 ? platforms : undefined,
    autoLaunch: false, // Gherkin flows use Background/Given steps to navigate
    ...(timeout !== undefined ? { timeout } : {}),
  };

  const allSteps = [...backgroundSteps, ...scenarioSteps];

  return {
    name,
    config,
    sourcePath: filePath,
    fn: async (flowCtx) => {
      const matcher = createStepMatcher(globalRegistry.getSteps());
      const state = new Map<string, unknown>();
      const worldFactory = getWorldFactory();
      const world = worldFactory?.instantiate(flowCtx, state);

      const scenarioStepResults: ScenarioStepResult[] = [];
      const beforeHooks = globalRegistry.getHooks("Before");
      const afterHooks = globalRegistry.getHooks("After");

      const stepCtx: StepContext = {
        ...flowCtx,
        state,
        ...world,
      };

      // Run Before hooks
      for (const hook of beforeHooks) {
        if (hook.tagExpression && !tagsMatch(tags, hook.tagExpression)) continue;
        const hookStart = Date.now();
        try {
          await hook.fn(stepCtx);
          scenarioStepResults.push({
            keyword: "Before",
            text: hook.tagExpression ?? "hook",
            status: "passed",
            durationMs: Date.now() - hookStart,
          });
        } catch (error) {
          scenarioStepResults.push({
            keyword: "Before",
            text: hook.tagExpression ?? "hook",
            status: "failed",
            durationMs: Date.now() - hookStart,
            error: error instanceof Error ? error.message : String(error),
          });
          // Still run After hooks, then rethrow
          await runAfterHooks(afterHooks, stepCtx, tags, scenarioStepResults);
          attachScenarioSteps(flowCtx, scenarioStepResults);
          throw error;
        }
      }

      // Run steps — fail fast, skip remaining
      let failed = false;
      let failError: unknown;

      for (const step of allSteps) {
        const keyword = normalizeKeyword(step.keyword);
        const stepStart = Date.now();

        if (failed) {
          scenarioStepResults.push({
            keyword,
            text: step.text,
            status: "skipped",
            durationMs: 0,
          });
          continue;
        }

        const match = matcher.match(step.text);
        if (!match) {
          const error = `Undefined step: "${step.keyword.trim()} ${step.text}"${filePath ? ` in ${filePath}` : ""}`;
          scenarioStepResults.push({
            keyword,
            text: step.text,
            status: "failed",
            durationMs: Date.now() - stepStart,
            error,
          });
          failed = true;
          failError = new Error(error);
          continue;
        }

        try {
          const args = buildStepArgs(match, step);
          await match.handler.fn(stepCtx, ...args);
          scenarioStepResults.push({
            keyword,
            text: step.text,
            status: "passed",
            durationMs: Date.now() - stepStart,
          });
        } catch (error) {
          scenarioStepResults.push({
            keyword,
            text: step.text,
            status: "failed",
            durationMs: Date.now() - stepStart,
            error: error instanceof Error ? error.message : String(error),
          });
          failed = true;
          failError = error;
        }
      }

      // Always run After hooks
      await runAfterHooks(afterHooks, stepCtx, tags, scenarioStepResults);
      attachScenarioSteps(flowCtx, scenarioStepResults);

      if (failError) throw failError;
    },
  };
}

async function runAfterHooks(
  hooks: readonly { tagExpression?: string; fn: (ctx: StepContext) => Promise<void> }[],
  stepCtx: StepContext,
  tags: string[],
  results: ScenarioStepResult[],
): Promise<void> {
  for (const hook of hooks) {
    if (hook.tagExpression && !tagsMatch(tags, hook.tagExpression)) continue;
    const hookStart = Date.now();
    try {
      await hook.fn(stepCtx);
      results.push({
        keyword: "After",
        text: hook.tagExpression ?? "hook",
        status: "passed",
        durationMs: Date.now() - hookStart,
      });
    } catch (error) {
      results.push({
        keyword: "After",
        text: hook.tagExpression ?? "hook",
        status: "failed",
        durationMs: Date.now() - hookStart,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function attachScenarioSteps(flowCtx: any, scenarioSteps: ScenarioStepResult[]): void {
  // The engine collects steps from the step recorder on flowCtx.
  // We attach scenarioSteps to a well-known property so the engine can pick them up.
  flowCtx.__scenarioSteps = scenarioSteps;
}

function extractFlowTags(tags: string[]): {
  platforms: Platform[];
  timeout: number | undefined;
  filteredTags: string[];
} {
  const platforms: Platform[] = [];
  const filteredTags: string[] = [];
  let timeout: number | undefined;

  for (const tag of tags) {
    const platform = PLATFORM_TAGS[tag.toLowerCase()];
    if (platform) {
      platforms.push(platform);
      continue;
    }
    // @timeout:90000 sets the flow-level timeout in milliseconds
    const timeoutMatch = /^@timeout:(\d+)$/i.exec(tag);
    if (timeoutMatch) {
      timeout = Number(timeoutMatch[1]);
      continue;
    }
    filteredTags.push(tag);
  }

  return { platforms, timeout, filteredTags };
}

function normalizeKeyword(keyword: string): ScenarioStepKeyword {
  const trimmed = keyword.trim();
  switch (trimmed) {
    case "Given":
      return "Given";
    case "When":
      return "When";
    case "Then":
      return "Then";
    case "And":
      return "And";
    case "But":
      return "But";
    case "*":
      return "And";
    default:
      return "Given";
  }
}

function replaceOutlinePlaceholders(text: string, replacements: Record<string, string>): string {
  return text.replaceAll(/<([^>]+)>/g, (_, key) => replacements[key] ?? `<${key}>`);
}

function buildStepArgs(match: MatchResult, step: GherkinStep): unknown[] {
  const args = [...match.args];

  if (step.dataTable) {
    const rows = step.dataTable.rows.map((r) => r.cells.map((c) => c.value));
    args.push(rows);
  }

  if (step.docString) {
    args.push(step.docString.content);
  }

  return args;
}

/** Simple tag expression matching — supports single tags and "and"/"not" */
function tagsMatch(scenarioTags: string[], expression: string): boolean {
  const parts = expression.split(/\s+/);
  let result = true;
  let negate = false;

  for (const part of parts) {
    if (part === "and") continue;
    if (part === "not") {
      negate = true;
      continue;
    }
    if (part === "or") {
      // Simple OR: if we already matched, we're done
      if (result) return true;
      result = true;
      continue;
    }

    const hasTag = scenarioTags.includes(part);
    const matches = negate ? !hasTag : hasTag;
    result = result && matches;
    negate = false;
  }

  return result;
}
