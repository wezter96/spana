import { flow } from "../../../../../packages/spana/dist/index.js";

const PORT = Number(process.env.STRESS_PORT || 4410);
const BASE = `http://127.0.0.1:${PORT}`;

const makeSmallFlow = (id: string) =>
  flow(id, async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    await app.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 80));
    });
  });

const makeLargeFlow = (idx: number) =>
  flow(`large-20-${String(idx).padStart(2, "0")}`, async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    await app.evaluate(async (label: string) => {
      await fetch(`/api/concurrency/enter?id=${encodeURIComponent(label)}`);
      try {
        await new Promise((r) => setTimeout(r, 350));
      } finally {
        await fetch(`/api/concurrency/leave?id=${encodeURIComponent(label)}`);
      }
    }, `large-${idx}`);
  });

export default [
  makeSmallFlow("small-1"),
  makeSmallFlow("small-2"),
  makeSmallFlow("small-3"),
  makeSmallFlow("small-4"),
  ...Array.from({ length: 20 }, (_, i) => makeLargeFlow(i + 1)),
];
