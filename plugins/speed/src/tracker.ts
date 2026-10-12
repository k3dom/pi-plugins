import {
  Array,
  Clock,
  Context,
  Duration,
  Effect,
  Number,
  Option,
  pipe,
} from 'effect'

export interface RecentSpeed {
  readonly tps: number
  readonly ttft: Duration.Duration
}

export class Tracker extends Context.Service<Tracker>()(
  '@pi-plugins/speed/Tracker',
  {
    make: Effect.gen(function* () {
      const clock = yield* Clock.Clock

      let samples: ReadonlyArray<{
        readonly model: string
        readonly recordedAt: bigint
        readonly ttft: Duration.Duration
        readonly generation: Duration.Duration
        readonly tokens: number
      }> = []
      let inflight:
        | {
            readonly startedAt: bigint
            firstDelta?: { readonly at: bigint; readonly chars: number }
            lastDeltaAt?: bigint
            visibleChars: number
            thinkingChars: number
          }
        | undefined

      const beginRequest = Effect.fn('Tracker.beginRequest')(function* () {
        inflight = {
          startedAt: yield* clock.monotonicTimeNanos,
          visibleChars: 0,
          thinkingChars: 0,
        }
      })

      const recordDelta = Effect.fnUntraced(function* (
        kind: 'thinking' | 'visible',
        length: number,
      ) {
        const request = inflight
        if (request === undefined || length === 0) {
          return Option.none()
        }

        const now = yield* clock.monotonicTimeNanos
        if (kind === 'thinking') {
          request.thinkingChars += length
        } else {
          request.visibleChars += length
        }

        if (request.firstDelta !== undefined) {
          request.lastDeltaAt = now
          return Option.none()
        }

        request.firstDelta = { at: now, chars: length }
        return Option.some(Duration.nanos(now - request.startedAt))
      })

      const endRequest = Effect.fn('Tracker.endRequest')(
        (outcome: {
          readonly model: string
          readonly stopReason: string
          readonly outputTokens: number
          readonly reasoningTokens: number | undefined
        }) =>
          Effect.sync(() => {
            const request = inflight
            inflight = undefined

            if (
              request?.firstDelta === undefined ||
              request.lastDeltaAt === undefined ||
              outcome.stopReason === 'error' ||
              outcome.stopReason === 'aborted' ||
              outcome.outputTokens <= 0
            ) {
              return
            }

            const generation = Duration.nanos(
              request.lastDeltaAt - request.firstDelta.at,
            )
            if (Duration.isLessThan(generation, Duration.millis(2))) {
              return
            }

            // Billed output includes hidden reasoning. Estimate only the portion
            // that streamed, using this request's visible characters per token.
            const reasoning = Number.min(
              outcome.reasoningTokens ?? 0,
              outcome.outputTokens,
            )
            const visible = outcome.outputTokens - reasoning
            const streamedReasoning = pipe(
              visible > 0 && request.visibleChars > 0
                ? Option.some(request.visibleChars / visible)
                : Option.none(),
              Option.match({
                onNone: () => (request.thinkingChars > 0 ? reasoning : 0),
                onSome: (density) => {
                  // Visible and thinking text have different token densities, so
                  // allow for that when distinguishing fully streamed reasoning
                  // from a summary.
                  const implied = request.thinkingChars / density
                  return implied >= reasoning * 0.6 ? reasoning : implied
                },
              }),
            )

            // The opening chunk predates the measured interval, so remove its
            // share.
            const chars = request.visibleChars + request.thinkingChars
            const tokens =
              ((visible + streamedReasoning) * (chars - request.firstDelta.chars)) /
              chars
            if (tokens <= 0) {
              return
            }

            samples = pipe(
              samples,
              Array.append({
                model: outcome.model,
                recordedAt: request.lastDeltaAt,
                ttft: Duration.nanos(request.firstDelta.at - request.startedAt),
                generation,
                tokens,
              }),
              Array.takeRight(1000),
            )
          }),
      )

      const recent = Effect.fn('Tracker.recent')(function* (model: string) {
        const now = yield* clock.monotonicTimeNanos
        const [, weighted] = pipe(
          Array.reverse(samples),
          Array.takeWhile((sample) =>
            Duration.isLessThanOrEqualTo(
              Duration.nanos(now - sample.recordedAt),
              Duration.minutes(30),
            ),
          ),
          Array.filter((sample) => sample.model === model),
          // Token-space decay keeps tiny tool calls from flushing the estimate or
          // idle time from changing its value.
          Array.mapAccum(0, (distance, sample) => [
            distance + sample.tokens,
            { weight: 0.5 ** (distance / 4000), sample },
          ]),
        )
        const window = Array.takeWhile(weighted, ({ weight }) => weight >= 1e-3)
        if (Array.isArrayEmpty(window)) {
          return Option.none()
        }

        const totalWeight = Number.sumAll(Array.map(window, ({ weight }) => weight))
        const tokens = Number.sumAll(
          Array.map(window, ({ weight, sample }) => weight * sample.tokens),
        )
        const millis = Number.sumAll(
          Array.map(
            window,
            ({ weight, sample }) => weight * Duration.toMillis(sample.generation),
          ),
        )

        // Weighted median keeps a retried request's backoff from dominating TTFT.
        const [, ranked] = Array.mapAccum(
          Array.sortWith(window, ({ sample }) => sample.ttft, Duration.Order),
          0,
          (seen, { weight, sample }) => [
            seen + weight,
            { seen: seen + weight, sample },
          ],
        )
        const ttft = pipe(
          ranked,
          Array.findFirst(({ seen }) => seen >= totalWeight / 2),
          Option.match({
            onNone: () => Duration.zero,
            onSome: ({ sample }) => sample.ttft,
          }),
        )

        // Divide the sums, not per-request rates: long responses carry more evidence.
        return Option.some<RecentSpeed>({ tps: (tokens / millis) * 1000, ttft })
      })

      const reset = Effect.fn('Tracker.reset')(() =>
        Effect.sync(() => {
          samples = []
          inflight = undefined
        }),
      )

      return { beginRequest, recordDelta, endRequest, recent, reset }
    }),
  },
) {}
