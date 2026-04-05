import { os } from "@orpc/server";
import type { StudioContext } from "./context.js";
import { devicesRouter } from "./routers/devices.js";
import { inspectorRouter } from "./routers/inspector.js";
import { testsRouter } from "./routers/tests.js";

export const o = os.$context<StudioContext>();
export const publicProcedure = o;

export const studioRouter = {
  devices: devicesRouter,
  inspector: inspectorRouter,
  tests: testsRouter,
};
export type StudioRouter = typeof studioRouter;
