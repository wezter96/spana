import { flow } from "../../../../../packages/spana/dist/index.js";

const PORT = Number(process.env.STRESS_PORT || 4410);
const BASE = `http://127.0.0.1:${PORT}`;

const makeWaveFlow = (id: string) =>
  flow(id, async ({ app }) => {
    await app.openLink(`${BASE}/wave2`);
    await app.evaluate(async (label: string) => {
      await fetch(`/api/concurrency/enter?id=${encodeURIComponent(label)}`);
      await new Promise((r) => setTimeout(r, 250));
      await fetch(`/api/concurrency/leave?id=${encodeURIComponent(label)}`);
    }, id);
  });

export const waveP1 = makeWaveFlow("wave-p1");
export const waveP2 = makeWaveFlow("wave-p2");
export const waveP3 = makeWaveFlow("wave-p3");
export const waveP4 = makeWaveFlow("wave-p4");
export const waveP5 = makeWaveFlow("wave-p5");

export default [waveP1, waveP2, waveP3, waveP4, waveP5];
