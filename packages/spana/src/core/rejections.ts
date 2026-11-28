// Named rejection handlers for `.catch(...)` on a promise nobody else awaits.
// Each name states why dropping the error there is correct; pick the one that fits, or handle the error.

/** The promise is awaited or raced later; this only stops an unhandled-rejection crash before that point, and the later await still sees the error. */
export function handledByLaterAwait(_error: unknown): void {}

/** A fire-and-forget side command (CDP ack, release, resume, cleanup) whose failure only means the target is already gone. */
export function ignoreBestEffortFailure(_error: unknown): void {}
