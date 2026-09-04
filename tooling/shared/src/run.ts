import { Cause, Effect, Exit, Inspectable } from 'effect'

export interface RunOptions {
  readonly signal?: AbortSignal | undefined
}

function causeMessage(cause: Cause.Cause<unknown>): string {
  if (Cause.hasInterruptsOnly(cause)) {
    // What pi's own tools throw for a cancelled run.
    return 'Operation aborted'
  }
  if (Cause.hasDies(cause)) {
    return Cause.pretty(cause)
  }
  return cause.reasons
    .filter(Cause.isFailReason)
    .map(({ error }) => {
      if (error instanceof Error) {
        return error.message || error.name
      }
      return typeof error === 'string' ? error : Inspectable.toStringUnknown(error)
    })
    .join('\n')
}

/** The rejection message is what the model reads back as the tool result. */
export async function runTool<A, E>(
  effect: Effect.Effect<A, E>,
  options?: RunOptions,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, options)
  if (Exit.isFailure(exit)) {
    throw new Error(causeMessage(exit.cause))
  }
  return exit.value
}

export interface RunHandlerOptions<B> {
  readonly onError?: (message: string) => B
}

export async function runHandler<A, E, B = undefined>(
  effect: Effect.Effect<A, E>,
  options?: RunHandlerOptions<B>,
): Promise<A | B> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) {
    return exit.value
  }
  if (options?.onError) {
    return options.onError(causeMessage(exit.cause))
  }
  const die = exit.cause.reasons.find(Cause.isDieReason)
  if (die !== undefined) {
    throw die.defect
  }
  return undefined as B
}
