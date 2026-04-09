import { z } from "zod";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { publicProcedure } from "../procedures.js";
import {
  RecordingSessionStore,
  type RecordingSession,
  type ActionType,
} from "../recording-session.js";
import { generateFlowCode } from "../../core/flow-generator.js";
import { getOrCreateSession } from "./inspector.js";

const store = new RecordingSessionStore();

const selectorSchema = z.union([
  z.string(),
  z.object({ testID: z.string() }),
  z.object({ text: z.string() }),
  z.object({ accessibilityLabel: z.string() }),
  z.object({ point: z.object({ x: z.number(), y: z.number() }) }),
]);

const platformEnum = z.enum(["web", "android", "ios"]);

export const recordingRouter = {
  start: publicProcedure
    .input(
      z.object({
        platform: platformEnum,
        deviceId: z.string().optional(),
      }),
    )
    .handler(async ({ input }) => {
      const session = store.start(input.platform);
      return { sessionId: session.id };
    }),

  stop: publicProcedure.input(z.object({ sessionId: z.string() })).handler(async ({ input }) => {
    store.stop(input.sessionId);
  }),

  addAction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        action: z.object({
          type: z.string() as z.ZodType<ActionType>,
          selector: selectorSchema.optional(),
          selectorAlternatives: z.array(selectorSchema).default([]),
          params: z.record(z.string(), z.unknown()).default({}),
          timestamp: z.number(),
          screenshotPath: z.string().optional(),
        }),
      }),
    )
    .handler(async ({ input }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = store.addAction(input.sessionId, input.action as any);
      if (!action) throw new Error(`Session not found: ${input.sessionId}`);
      return { actionId: action.id };
    }),

  deleteAction: publicProcedure
    .input(z.object({ sessionId: z.string(), actionId: z.string() }))
    .handler(async ({ input }) => {
      store.deleteAction(input.sessionId, input.actionId);
    }),

  reorderActions: publicProcedure
    .input(z.object({ sessionId: z.string(), actionIds: z.array(z.string()) }))
    .handler(async ({ input }) => {
      store.reorderActions(input.sessionId, input.actionIds);
    }),

  updateSelector: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        actionId: z.string(),
        selector: selectorSchema,
      }),
    )
    .handler(async ({ input }) => {
      store.updateSelector(input.sessionId, input.actionId, input.selector);
    }),

  getSession: publicProcedure
    .input(z.object({ sessionId: z.string() }))
    .handler(async ({ input }): Promise<RecordingSession> => {
      const session = store.get(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      return session;
    }),

  generateCode: publicProcedure
    .input(z.object({ sessionId: z.string(), flowName: z.string() }))
    .handler(async ({ input }) => {
      const session = store.get(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      const code = generateFlowCode(input.flowName, session.actions);
      return { code };
    }),

  save: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        flowName: z.string(),
        flowDir: z.string().optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const session = store.get(input.sessionId);
      if (!session) throw new Error(`Session not found: ${input.sessionId}`);
      const code = generateFlowCode(input.flowName, session.actions);
      const dir = input.flowDir ?? context.config.flowDir ?? "flows";
      const fileName = `${input.flowName}.ts`;
      const filePath = path.resolve(dir, fileName);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(filePath, code, "utf8");
      return { filePath, code };
    }),

  executeAction: publicProcedure
    .input(
      z.object({
        sessionId: z.string(),
        platform: platformEnum,
        deviceId: z.string().optional(),
        actionType: z.string() as z.ZodType<ActionType>,
        selector: selectorSchema.optional(),
        params: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .handler(async ({ input, context }) => {
      const agentSession = await getOrCreateSession(input.platform, context.config, input.deviceId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sel = input.selector as any;
      const params = input.params ?? {};

      switch (input.actionType) {
        case "tap":
          if (sel) await agentSession.tap(sel);
          break;
        case "doubleTap":
          if (sel) await agentSession.doubleTap(sel);
          break;
        case "longPress":
          if (sel) await agentSession.longPress(sel);
          break;
        case "inputText":
          await agentSession.inputText(String(params.text ?? ""));
          break;
        case "scroll":
          await agentSession.scroll(
            String(params.direction ?? "down") as Parameters<typeof agentSession.scroll>[0],
          );
          break;
        case "swipe":
          await agentSession.swipe(
            String(params.direction ?? "left") as Parameters<typeof agentSession.swipe>[0],
          );
          break;
        case "pressKey":
          await agentSession.pressKey(String(params.key ?? ""));
          break;
        case "back":
          await agentSession.back();
          break;
        default:
          break;
      }

      const selectorAlternatives = await agentSession.selectors();
      return { selectorAlternatives };
    }),
};
