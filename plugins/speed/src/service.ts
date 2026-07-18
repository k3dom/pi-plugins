import { Array, Context, Effect, Number, Order, pipe, Record } from 'effect'

const MAX_SAMPLES = 1000
const LIVE_UPDATE_INTERVAL_MS = 500
/** Rough heuristic for the live estimate, corrected by real usage at message end. */
const CHARS_PER_TOKEN = 4

export interface Sample {
  readonly model: string
  readonly ttftMs: number
  readonly generationMs: number
  readonly outputTokens: number
}

export interface ModelStats {
  readonly model: string
  readonly requests: number
  readonly tps: number
  readonly totalTokens: number
  readonly ttft: TailSummary
  readonly requestTps: TailSummary
}

export interface TailSummary {
  readonly p50: number | undefined
  readonly p95: number | undefined
  readonly worst: number
}

export interface LiveEstimate {
  readonly tps: number
  readonly ttftMs: number
}

export interface SessionReport {
  readonly requestCount: number
  readonly last: Sample | undefined
  readonly stats: readonly ModelStats[]
}

export interface RequestOutcome {
  readonly model: string
  readonly stopReason: string
  readonly outputTokens: number
}

interface InflightRequest {
  readonly requestStart: number
  firstTokenAt?: number
  deltaChars: number
  lastLiveUpdate: number
}

/**
 * A quantile is reported only when at least this many samples lie strictly
 * beyond its rank, so it is genuinely interior rather than a relabeled
 * (near-)max. Yields gates of n ≥ 4 for p50 and n ≥ 40 for p95.
 */
const MIN_SAMPLES_BEYOND = 2

/** Nearest-rank quantile of a sorted array (worse tail last); `NaN` when empty. */
export function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(
    Math.max(Math.ceil(q * sorted.length) - 1, 0),
    sorted.length - 1,
  )
  return sorted[index] ?? globalThis.Number.NaN
}

export function tailSummary(
  values: readonly number[],
  worse: 'high' | 'low',
): TailSummary {
  // Worse tail last, so nearest-rank treats latency and throughput symmetrically.
  const sorted = Array.sort(
    values,
    worse === 'high' ? Order.Number : Order.flip(Order.Number),
  )
  const gated = (q: number) =>
    sorted.length - Math.ceil(q * sorted.length) >= MIN_SAMPLES_BEYOND
      ? quantile(sorted, q)
      : undefined
  return {
    p50: gated(0.5),
    p95: gated(0.95),
    worst: quantile(sorted, 1),
  }
}

export function tokensPerSecond(sample: Sample): number {
  return sample.outputTokens / (sample.generationMs / 1000)
}

/**
 * Tracks inference speed across one session: measures the in-flight provider
 * request and accumulates completed requests into a bounded sample window.
 */
export class SpeedTracker extends Context.Service<SpeedTracker>()(
  '@pi-plugins/speed/SpeedTracker',
  {
    make: Effect.sync(() => {
      const samples: Sample[] = []
      let inflight: InflightRequest | undefined

      /** One LLM request is about to go out; the TTFT start anchor. */
      function beginRequest(): void {
        inflight = {
          requestStart: performance.now(),
          deltaChars: 0,
          lastLiveUpdate: 0,
        }
      }

      /** Returns a fresh live estimate, or undefined while throttled or idle. */
      function recordDelta(chars: number): LiveEstimate | undefined {
        const request = inflight
        if (request === undefined) {
          return undefined
        }

        const now = performance.now()
        request.firstTokenAt ??= now
        request.deltaChars += chars

        if (now - request.lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS) {
          return undefined
        }
        request.lastLiveUpdate = now

        const elapsedSeconds = (now - request.firstTokenAt) / 1000
        if (elapsedSeconds <= 0) {
          return undefined
        }
        return {
          tps: request.deltaChars / CHARS_PER_TOKEN / elapsedSeconds,
          ttftMs: request.firstTokenAt - request.requestStart,
        }
      }

      function endRequest(outcome: RequestOutcome): void {
        const request = inflight
        inflight = undefined
        const end = performance.now()

        if (
          request?.firstTokenAt === undefined ||
          outcome.stopReason === 'error' ||
          outcome.stopReason === 'aborted' ||
          outcome.outputTokens <= 0
        ) {
          // Nothing measurable or an interrupted stream: drop the measurement.
          return
        }

        samples.push({
          model: outcome.model,
          ttftMs: request.firstTokenAt - request.requestStart,
          generationMs: Math.max(end - request.firstTokenAt, 1),
          outputTokens: outcome.outputTokens,
        })
        if (samples.length >= MAX_SAMPLES * 2) {
          // Amortized trim: let the buffer grow to twice the window, then cut
          // back in one splice instead of shifting on every append.
          samples.splice(0, samples.length - MAX_SAMPLES)
        }
      }

      function lastSample(): Sample | undefined {
        return samples.at(-1)
      }

      function report(): SessionReport {
        return {
          requestCount: samples.length,
          last: samples.at(-1),
          // Grouped by model, most-used model first.
          stats: pipe(
            Record.toEntries(Array.groupBy(samples, (sample) => sample.model)),
            Array.map(([model, group]): ModelStats => {
              const totalTokens = Number.sumAll(
                group.map((sample) => sample.outputTokens),
              )
              return {
                model,
                requests: group.length,
                tps:
                  totalTokens /
                  (Number.sumAll(group.map((sample) => sample.generationMs)) / 1000),
                totalTokens,
                ttft: tailSummary(
                  group.map((sample) => sample.ttftMs),
                  'high',
                ),
                requestTps: tailSummary(group.map(tokensPerSecond), 'low'),
              }
            }),
            Array.sortWith(
              (stats: ModelStats) => stats.requests,
              Order.flip(Order.Number),
            ),
          ),
        }
      }

      return { beginRequest, recordDelta, endRequest, lastSample, report } as const
    }),
  },
) {}
