import {
  Array,
  Cause,
  Effect,
  Exit,
  Inspectable,
  Option,
  pipe,
  Predicate,
} from 'effect'

function causeMessage(cause: Cause.Cause<unknown>): string {
  if (Cause.hasInterruptsOnly(cause)) {
    // What pi's own tools throw for a cancelled run.
    return 'Operation aborted'
  }
  if (Cause.hasDies(cause)) {
    return Cause.pretty(cause)
  }
  return pipe(
    cause.reasons,
    Array.filter(Cause.isFailReason),
    Array.map(({ error }) => {
      if (error instanceof Error) {
        return error.message || error.name
      }
      return Predicate.isString(error) ? error : Inspectable.toStringUnknown(error)
    }),
    Array.join('\n'),
  )
}

/** The rejection message is what the model reads back as the tool result. */
export async function tool<A, E>(
  effect: Effect.Effect<A, E>,
  options?: { readonly signal?: AbortSignal | undefined },
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options)
  if (Exit.isFailure(exit)) {
    throw new Error(causeMessage(exit.cause))
  }
  return exit.value
}

export async function handler<A, E, B = undefined>(
  effect: Effect.Effect<A, E>,
  options?: { readonly onError?: (message: string) => B },
): Promise<A | B> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  if (options?.onError) {
    return options.onError(causeMessage(exit.cause))
  }
  const die = Array.findFirst(exit.cause.reasons, Cause.isDieReason)
  if (Option.isSome(die)) {
    throw die.value.defect
  }
  return undefined as B
}
