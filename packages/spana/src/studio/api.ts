import { devicesRouter } from "./routers/devices.js";
import { inspectorRouter } from "./routers/inspector.js";
import { recordingRouter } from "./routers/recording.js";
import { testsRouter } from "./routers/tests.js";

export { o, publicProcedure } from "./procedures.js";

export const studioRouter = {
  devices: devicesRouter,
  inspector: inspectorRouter,
  recording: recordingRouter,
  tests: testsRouter,
};
export type StudioRouter = typeof studioRouter;
