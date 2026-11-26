import { Cause, Effect, Exit, Result, type ManagedRuntime, type Scope } from "effect";
import { ORPCError } from "@orpc/server";

export const runEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R | Scope.Scope>,
  runtime: ManagedRuntime.ManagedRuntime<R, any>,
): Promise<A> =>
  runtime.runPromiseExit(Effect.scoped(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }

    const error = Cause.findError(exit.cause);
    if (Result.isSuccess(error) && error.success instanceof ORPCError) {
      throw error.success;
    }

    const defect = Cause.findDefect(exit.cause);
    if (Result.isSuccess(defect) && defect.success instanceof ORPCError) {
      throw defect.success;
    }

    throw new ORPCError("INTERNAL_SERVER_ERROR");
  });
