import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Clock, Duration, Effect, Fiber, Schedule, String } from 'effect'

function formatElapsed(duration: Duration.Duration): string {
  const { days, hours, minutes, seconds } = Duration.parts(duration)
  const pad = String.padStart(2, '0')

  if (days > 0 || hours > 0) {
    return `${days * 24 + hours}h ${pad(`${minutes}`)}m ${pad(`${seconds}`)}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(`${seconds}`)}s`
  }
  return `${seconds}s`
}

export default function elapsed(pi: ExtensionAPI) {
  let ticker: Fiber.Fiber<void> | undefined

  function stop(ctx: ExtensionContext): void {
    if (ticker === undefined) {
      return
    }
    Effect.runFork(Fiber.interrupt(ticker))
    ticker = undefined
    ctx.ui.setWorkingMessage()
  }

  pi.on('agent_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }
    stop(ctx)

    ticker = Effect.runFork(
      Effect.gen(function* () {
        const startedAt = yield* Clock.monotonicTimeNanos
        yield* Effect.gen(function* () {
          const now = yield* Clock.monotonicTimeNanos
          // pi's own default working message, so the clock reads as an extension of it.
          ctx.ui.setWorkingMessage(
            `Working... ${formatElapsed(Duration.nanos(now - startedAt))}`,
          )
        }).pipe(Effect.repeat(Schedule.spaced('1 second')))
      }),
    )
  })

  pi.on('agent_end', (_event, ctx) => {
    stop(ctx)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    stop(ctx)
  })
}
