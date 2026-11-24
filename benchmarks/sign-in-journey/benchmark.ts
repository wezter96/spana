#!/usr/bin/env bun
import {
  formatSignInBenchmarkTable,
  runAllTargetsSignInBenchmark,
} from "../../packages/spana/src/core/benchmark.js";

const rows = await runAllTargetsSignInBenchmark();
console.log(
  "\nSpana Web-First Sign-In Journey Benchmark (UI OAuth Sheet vs Bridge State Injection)\n",
);
console.log(formatSignInBenchmarkTable(rows));
console.log(
  "\nNote: Bridge sign-in skips the out-of-process OAuth sheet and native accessibility dumps completely (0 native dumps across all 5 targets).\n",
);
