import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const cliPath = resolve(repoRoot, "packages/spana/dist/cli.js");
const configPath = resolve(here, "spana.config.ts");
const resultsJsonOut = resolve(here, "results.json");
const PRIMARY_PORT = Number(process.env.STRESS_PORT || 4410);
const CROSS_ORIGIN_PORT = Number(process.env.STRESS_OOPIF_PORT || 4411);
// Dedicated short (<40 chars) TMPDIR so our orphan-Chrome audit catches 100% of leaks
// from this run without false-positives from concurrent Spana runs in sibling repos.
const runTmpDir = `/tmp/spb-${process.pid}`;
mkdirSync(runTmpDir, { recursive: true });

function countOrphanSpanaChromes() {
  try {
    const out = execFileSync("pgrep", ["-fa", `${runTmpDir}/spana-cdp-`], {
      encoding: "utf8",
    }).trim();
    if (!out) return 0;
    return out.split("\n").filter((line) => line.trim() && !line.includes("pgrep")).length;
  } catch {
    return 0;
  }
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error(`Server did not become healthy at ${url} within ${timeoutMs}ms`);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function summarizeDurations(durations) {
  if (durations.length === 0) return { count: 0, sumMs: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const sorted = durations.toSorted((a, b) => a - b);
  const sumMs = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    sumMs: Math.round(sumMs),
    avgMs: Math.round(sumMs / sorted.length),
    p50Ms: Math.round(percentile(sorted, 50)),
    p95Ms: Math.round(percentile(sorted, 95)),
    maxMs: Math.round(sorted[sorted.length - 1]),
  };
}

function runCommandWithRss(cmd, args, opts = {}) {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const useTime = existsSync("/usr/bin/time");
    const timeOutFile = useTime
      ? resolve(
          here,
          `.time-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
        )
      : null;
    const spawnCmd = useTime ? "/usr/bin/time" : cmd;
    const spawnArgs = useTime ? ["-v", "-o", timeOutFile, cmd, ...args] : args;

    const child = spawn(spawnCmd, spawnArgs, {
      cwd: opts.cwd || here,
      env: { ...process.env, TMPDIR: runTmpDir, ...opts.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      const wallMs = Date.now() - startedAt;
      let peakRssKb = null;
      if (timeOutFile && existsSync(timeOutFile)) {
        try {
          const timeText = readFileSync(timeOutFile, "utf8");
          const m = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(timeText);
          if (m) peakRssKb = Number(m[1]);
        } finally {
          rmSync(timeOutFile, { force: true });
        }
      }
      resolvePromise({
        exitCode: code ?? -1,
        wallMs,
        peakRssMb: peakRssKb !== null ? Number((peakRssKb / 1024).toFixed(1)) : null,
        stdout,
        stderr,
      });
    });
  });
}

async function runMatrixEntry(entry) {
  const reportFile = resolve(here, `.report-${entry.id}.json`);
  try {
    rmSync(reportFile, { force: true });
  } catch {}

  const cliArgs = [
    cliPath,
    "test",
    "--config",
    configPath,
    "--workers",
    String(entry.workers),
    "--reporter",
    `json:${reportFile}`,
  ];

  console.log(
    `\n=== Running [${entry.id}] (${entry.runtime} | ${entry.isolation} | ${entry.workers}w) ===`,
  );
  const run = await runCommandWithRss(entry.bin, cliArgs, {
    env: {
      STRESS_PORT: String(PRIMARY_PORT),
      STRESS_OOPIF_PORT: String(CROSS_ORIGIN_PORT),
      STRESS_ISOLATION: entry.isolation,
      STRESS_ENGINE: "cdp",
    },
  });

  // Give Chrome's subprocesses up to 1.5s to finish exiting before flagging true orphans
  let orphanChromes = 0;
  for (let waitAttempt = 0; waitAttempt < 10; waitAttempt++) {
    await new Promise((r) => setTimeout(r, 150));
    orphanChromes = countOrphanSpanaChromes();
    if (orphanChromes === 0) break;
  }

  let report = null;
  if (existsSync(reportFile)) {
    report = JSON.parse(readFileSync(reportFile, "utf8"));
  }
  const results = report?.results || [];
  const passed = results.filter((r) => r.status === "passed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const flaky = results.filter((r) => r.flaky).length;
  const failures = results
    .filter((r) => r.status === "failed")
    .map((r) => ({ name: r.name, error: r.error?.message || String(r.error || "unknown") }));

  const byProfile = {};
  for (let p = 1; p <= 12; p++) {
    const prefix = `P${p}-`;
    const profResults = results.filter((r) => r.name.includes(prefix));
    byProfile[`P${p}`] = {
      passed: profResults.filter((r) => r.status === "passed").length,
      failed: profResults.filter((r) => r.status === "failed").length,
      ...summarizeDurations(profResults.map((r) => r.durationMs || 0)),
    };
  }

  const allDurations = results.map((r) => r.durationMs || 0);
  const overall = summarizeDurations(allDurations);
  const approxLaunchOverheadMs = Math.max(
    0,
    Math.round(run.wallMs - overall.sumMs / Math.max(1, entry.workers)),
  );

  console.log(
    `Result [${entry.id}]: ${passed}/${results.length} passed, ${failed} failed, wall=${(run.wallMs / 1000).toFixed(2)}s, avg=${overall.avgMs}ms, p50=${overall.p50Ms}ms, p95=${overall.p95Ms}ms, overhead~${approxLaunchOverheadMs}ms, peakRSS=${run.peakRssMb ?? "n/a"}MB, orphans=${orphanChromes}`,
  );
  if (failures.length > 0) {
    for (const f of failures) {
      console.log(`  FAIL: ${f.name} -> ${f.error.slice(0, 240)}`);
    }
  }
  if (run.exitCode !== 0 && failures.length === 0) {
    console.log(
      `  EXIT=${run.exitCode}\n  STDERR: ${run.stderr.slice(-1000)}\n  STDOUT: ${run.stdout.slice(-1000)}`,
    );
  }

  return {
    id: entry.id,
    runtime: entry.runtime,
    isolation: entry.isolation,
    workers: entry.workers,
    exitCode: run.exitCode,
    wallMs: run.wallMs,
    peakRssMb: run.peakRssMb,
    approxLaunchOverheadMs,
    orphanChromes,
    total: results.length,
    passed,
    failed,
    flaky,
    overall,
    byProfile,
    failures,
  };
}

async function runExtraChecks() {
  const checks = [];
  const projectsDir = resolve(here, "projects-test");
  const projectsCfg = resolve(projectsDir, "spana-projects.config.ts");
  const authStateFile = resolve(projectsDir, ".auth-state.json");

  for (const [label, bin] of [
    ["node", process.execPath],
    ["bun", "bun"],
  ]) {
    // 1. spana test --help
    const helpRes = await runCommandWithRss(bin, [cliPath, "test", "--help"]);
    checks.push({
      name: `${label}: spana test --help`,
      ok: helpRes.exitCode === 0 && helpRes.stdout.includes("Usage: spana test"),
      detail: `exit=${helpRes.exitCode}`,
    });

    // 2. dependencies: ["setup"] with --tag smoke (auth setup MUST NOT be skipped!)
    rmSync(authStateFile, { force: true });
    const depRes = await runCommandWithRss(
      bin,
      [cliPath, "test", "--config", projectsCfg, "--tag", "smoke"],
      {
        cwd: projectsDir,
        env: { STRESS_PORT: String(PRIMARY_PORT) },
      },
    );
    checks.push({
      name: `${label}: dependencies:[setup] with --tag smoke`,
      ok:
        depRes.exitCode === 0 &&
        depRes.stdout.includes("auth.setup") &&
        depRes.stdout.includes("authed-smoke") &&
        !depRes.stdout.includes("authed-extra") &&
        depRes.stdout.includes("web (Direct CDP)"),
      detail: `exit=${depRes.exitCode}, hasDirectCdp=${depRes.stdout.includes("web (Direct CDP)")}`,
      errorLog: depRes.stdout + "\n" + depRes.stderr,
    });

    // 3. Multi-file positional CLI args
    const multiRes = await runCommandWithRss(
      bin,
      [
        cliPath,
        "test",
        "--config",
        configPath,
        "flows/01-spa-hydration-text.flow.ts",
        "flows/03-hover-focus-visibility.flow.ts",
        "--grep",
        "P1-01|P3-01",
      ],
      { env: { STRESS_PORT: String(PRIMARY_PORT), STRESS_ISOLATION: "fresh" } },
    );
    checks.push({
      name: `${label}: multi-file positional CLI args`,
      ok:
        multiRes.exitCode === 0 &&
        multiRes.stdout.includes("P1-01") &&
        multiRes.stdout.includes("P3-01"),
      detail: `exit=${multiRes.exitCode}`,
      errorLog: multiRes.stdout + "\n" + multiRes.stderr,
    });

    // 4. Deep TMPDIR (>108 bytes) Chromium launch resilience
    const deepTmp = `/tmp/spana-deep-tmpdir-${"a".repeat(95)}`;
    mkdirSync(deepTmp, { recursive: true });
    const deepRes = await runCommandWithRss(
      bin,
      [
        cliPath,
        "test",
        "--config",
        configPath,
        "flows/10-resilience-chaos.flow.ts",
        "--grep",
        "P10-01",
      ],
      {
        env: {
          TMPDIR: deepTmp,
          STRESS_PORT: String(PRIMARY_PORT),
          STRESS_ISOLATION: "fresh",
        },
      },
    );
    rmSync(deepTmp, { recursive: true, force: true });
    checks.push({
      name: `${label}: deep TMPDIR (>108B) Chromium launch`,
      ok: deepRes.exitCode === 0 && deepRes.stdout.includes("P10-01"),
      detail: `exit=${deepRes.exitCode}`,
      errorLog: deepRes.stdout + "\n" + deepRes.stderr,
    });

    // 5. spana validate without path reads config.flowDir
    const valRes = await runCommandWithRss(bin, [cliPath, "validate"], { cwd: here });
    checks.push({
      name: `${label}: spana validate reads config.flowDir`,
      ok: valRes.exitCode === 0 && valRes.stdout.includes("12 flow(s) valid"),
      detail: `exit=${valRes.exitCode}, out=${valRes.stdout.trim()}`,
    });

    // 5b. Runtime ctx.skip() exits 0 and reports skipped flow cleanly
    const skipFlowPath = resolve(here, `.tmp-skip-${label}.flow.ts`);
    writeFileSync(
      skipFlowPath,
      `import { flow } from "../../packages/spana/dist/index.js";
export default flow("runtime-skip-check", async (ctx) => {
  ctx.skip("feature disabled in stress check");
});
`,
    );
    const skipRes = await runCommandWithRss(
      bin,
      [cliPath, "test", "--config", configPath, skipFlowPath],
      { env: { STRESS_PORT: String(PRIMARY_PORT), STRESS_ISOLATION: "fresh" } },
    );
    rmSync(skipFlowPath, { force: true });
    checks.push({
      name: `${label}: runtime ctx.skip() exits 0 & reports skipped`,
      ok:
        skipRes.exitCode === 0 &&
        skipRes.stdout.includes("1 skipped") &&
        skipRes.stdout.includes("feature disabled in stress check"),
      detail: `exit=${skipRes.exitCode}`,
      errorLog: skipRes.stdout + "\n" + skipRes.stderr,
    });

    // 6. Multi-project wave concurrency cap: 5 projects in 1 wave with --workers 2 MUST cap peak <= 2
    const waveCapDir = resolve(projectsDir, "wave-cap");
    const waveCapCfg = resolve(waveCapDir, "spana-wavecap.config.ts");
    await fetch(`http://127.0.0.1:${PRIMARY_PORT}/api/concurrency/reset`);
    const waveRes = await runCommandWithRss(
      bin,
      [cliPath, "test", "--config", waveCapCfg, "--workers", "2"],
      {
        cwd: waveCapDir,
        env: { STRESS_PORT: String(PRIMARY_PORT) },
      },
    );
    const concStats = await fetch(`http://127.0.0.1:${PRIMARY_PORT}/api/concurrency/stats`).then(
      (r) => r.json(),
    );
    checks.push({
      name: `${label}: 5-project wave caps concurrency to --workers 2`,
      ok:
        waveRes.exitCode === 0 &&
        concStats.totalEntered === 5 &&
        concStats.peak >= 1 &&
        concStats.peak <= 2,
      detail: `exit=${waveRes.exitCode}, entered=${concStats.totalEntered}, peak=${concStats.peak}`,
      errorLog: waveRes.stdout + "\n" + waveRes.stderr,
    });
  }

  await new Promise((r) => setTimeout(r, 350));
  const orphanAfterExtra = countOrphanSpanaChromes();
  checks.push({
    name: "orphan-check after extra checks",
    ok: orphanAfterExtra === 0,
    detail: `orphans=${orphanAfterExtra}`,
  });

  console.log("\n=== Extra CLI & Resilience Checks ===");
  for (const c of checks) {
    console.log(`  ${c.ok ? "✓" : "✗"} ${c.name} (${c.detail})`);
    if (!c.ok && c.errorLog) {
      console.log(`    LOG: ${c.errorLog.slice(-600).replaceAll("\n", "\n    ")}`);
    }
  }
  return checks;
}

const server = spawn(process.execPath, [resolve(here, "server.mjs")], {
  env: {
    ...process.env,
    STRESS_PORT: String(PRIMARY_PORT),
    STRESS_OOPIF_PORT: String(CROSS_ORIGIN_PORT),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

try {
  await waitForHealth(`http://127.0.0.1:${PRIMARY_PORT}/health`);
  console.log(`Stress server ready on :${PRIMARY_PORT} and :${CROSS_ORIGIN_PORT}`);

  const matrixFilter = process.env.STRESS_MATRIX_FILTER || "";
  const fullMatrix = [
    { id: "node-fresh-1w", runtime: "node", bin: process.execPath, isolation: "fresh", workers: 1 },
    {
      id: "node-hot-1w",
      runtime: "node",
      bin: process.execPath,
      isolation: "hot-cache",
      workers: 1,
    },
    { id: "node-fresh-4w", runtime: "node", bin: process.execPath, isolation: "fresh", workers: 4 },
    {
      id: "node-hot-4w",
      runtime: "node",
      bin: process.execPath,
      isolation: "hot-cache",
      workers: 4,
    },
    { id: "bun-fresh-1w", runtime: "bun", bin: "bun", isolation: "fresh", workers: 1 },
    { id: "bun-hot-1w", runtime: "bun", bin: "bun", isolation: "hot-cache", workers: 1 },
    { id: "bun-fresh-4w", runtime: "bun", bin: "bun", isolation: "fresh", workers: 4 },
    { id: "bun-hot-4w", runtime: "bun", bin: "bun", isolation: "hot-cache", workers: 4 },
  ].filter((e) => !matrixFilter || e.id.includes(matrixFilter));

  const matrixResults = [];
  for (const entry of fullMatrix) {
    matrixResults.push(await runMatrixEntry(entry));
  }

  const extraChecks = process.env.SKIP_EXTRA_CHECKS ? [] : await runExtraChecks();

  const summary = {
    generatedAt: new Date().toISOString(),
    nodeVersion: process.version,
    bunVersion: execFileSync("bun", ["--version"], { encoding: "utf8" }).trim(),
    matrix: matrixResults,
    extraChecks,
  };
  writeFileSync(resultsJsonOut, JSON.stringify(summary, null, 2));
  console.log(`\nWrote profiling results to ${resultsJsonOut}`);

  const anyFail =
    matrixResults.some(
      (m) => m.exitCode !== 0 || m.failed > 0 || m.passed !== 120 || m.orphanChromes > 0,
    ) || extraChecks.some((c) => !c.ok);
  process.exitCode = anyFail ? 1 : 0;
} finally {
  server.kill("SIGTERM");
  rmSync(runTmpDir, { recursive: true, force: true });
}
