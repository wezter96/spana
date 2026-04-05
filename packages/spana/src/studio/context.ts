import type { ManagedRuntime } from "effect";

export type StudioContext = {
  runtime: ManagedRuntime.ManagedRuntime<never, never>;
};
