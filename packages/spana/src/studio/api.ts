import { os } from "@orpc/server";
import type { StudioContext } from "./context.js";

export const o = os.$context<StudioContext>();
export const publicProcedure = o;

export const studioRouter = {};
export type StudioRouter = typeof studioRouter;
