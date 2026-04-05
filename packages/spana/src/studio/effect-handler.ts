import { Cause, Effect, Exit, type ManagedRuntime, type Scope } from "effect";
import { ORPCError } from "@orpc/server";

export const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, any>,
): Promise<A> =>
  runtime.runPromiseExit(Effect.scoped(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    if (Cause.isFailType(exit.cause)) {
      const error = exit.cause.error;
      if (error instanceof ORPCError) {
        throw error;
      }
    }

    if (Cause.isDieType(exit.cause)) {
      const defect = exit.cause.defect;
      if (defect instanceof ORPCError) {
        throw defect;
      }
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR");
  });
