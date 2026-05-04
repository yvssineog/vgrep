import { Effect } from "effect";

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** `Effect.tryPromise` with the error pinned to `Error`. Saves the boilerplate
 *  `{ try, catch: (e) => e instanceof Error ? e : new Error(String(e)) }` at
 *  every call site. */
export const tryAsync = <A>(thunk: () => Promise<A>): Effect.Effect<A, Error> =>
  Effect.tryPromise({ try: thunk, catch: toError });

/** Synchronous twin of `tryAsync`. */
export const trySync = <A>(thunk: () => A): Effect.Effect<A, Error> =>
  Effect.try({ try: thunk, catch: toError });
