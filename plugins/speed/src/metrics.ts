import { Array, MutableList, Number as EffectNumber, Option, pipe } from 'effect'

export type FirstOutputKind = 'text' | 'thinking' | 'tool'
export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'

export interface ActiveMeasurement {
  readonly id: number
  readonly requestAt: number
  readonly responseAt?: number | undefined
  readonly firstOutputAt?: number | undefined
  readonly firstOutputKind?: FirstOutputKind | undefined
}

export interface Completion {
  readonly provider: string
  readonly model: string
  readonly stopReason: StopReason
  readonly outputTokens: number
}

/** Metrics for one logical provider stream (one finalized assistant message). */
export interface SpeedSample {
  readonly id: number
  readonly provider: string
  readonly model: string
  readonly stopReason: StopReason
  readonly firstOutputKind?: FirstOutputKind | undefined
  readonly outputTokens: number
  readonly totalMs: number
  readonly responseHeadersMs?: number | undefined
  readonly firstOutputAfterHeadersMs?: number | undefined
  readonly ttftMs?: number | undefined
  readonly generationMs?: number | undefined
  readonly outputTps?: number | undefined
}

export interface SpeedSummary {
  readonly calls: number
  readonly ttftCalls: number
  readonly measuredCalls: number
  readonly failedCalls: number
  readonly averageTtftMs?: number | undefined
  readonly p50TtftMs?: number | undefined
  readonly p95TtftMs?: number | undefined
  readonly weightedTps?: number | undefined
  readonly measuredTokenIntervals: number
  readonly measuredGenerationMs: number
}

export interface SpeedTracker {
  readonly active: () => ActiveMeasurement | undefined
  readonly start: () => ActiveMeasurement
  readonly markResponse: () => ActiveMeasurement | undefined
  readonly markFirstOutput: (kind: FirstOutputKind) => ActiveMeasurement | undefined
  readonly finish: (completion: Completion) => SpeedSample | undefined
  readonly abandon: () => boolean
  readonly samples: () => readonly SpeedSample[]
  readonly resetHistory: () => void
  readonly resetSession: () => void
}

function elapsed(from: number, to: number): number {
  return Math.max(to - from, 0)
}

function divide(numerator: number, denominator: number): number | undefined {
  if (
    !globalThis.Number.isFinite(numerator) ||
    !globalThis.Number.isFinite(denominator)
  ) {
    return undefined
  }

  return pipe(
    EffectNumber.divide(numerator, denominator),
    Option.filter(globalThis.Number.isFinite),
    Option.getOrUndefined,
  )
}

function percentile(
  values: readonly number[],
  quantile: number,
): number | undefined {
  return Array.match(Array.sort(values, EffectNumber.Order), {
    onEmpty: () => undefined,
    onNonEmpty: (sorted) => {
      const index = Math.max(Math.ceil(quantile * sorted.length) - 1, 0)
      return Array.getUnsafe(sorted, index)
    },
  })
}

/** Aggregate logical calls without giving short responses disproportionate weight. */
export function summarize(samples: readonly SpeedSample[]): SpeedSummary {
  const ttfts = pipe(
    samples,
    Array.filter(
      (
        sample,
      ): sample is SpeedSample & {
        readonly ttftMs: number
        readonly stopReason: Exclude<StopReason, 'error' | 'aborted'>
      } =>
        sample.ttftMs !== undefined &&
        sample.stopReason !== 'error' &&
        sample.stopReason !== 'aborted',
    ),
    Array.map((sample) => sample.ttftMs),
  )
  const measured = Array.filter(
    samples,
    (sample) => sample.outputTps !== undefined && sample.generationMs !== undefined,
  )
  // TTFT accounts for the first token, so only the remaining token intervals
  // belong in the generation-rate numerator.
  const measuredTokenIntervals = Array.reduce(
    measured,
    0,
    (total, sample) => total + Math.max(sample.outputTokens - 1, 0),
  )
  const measuredGenerationMs = Array.reduce(
    measured,
    0,
    (total, sample) => total + (sample.generationMs ?? 0),
  )

  return {
    calls: samples.length,
    ttftCalls: ttfts.length,
    measuredCalls: measured.length,
    failedCalls: Array.filter(
      samples,
      (sample) => sample.stopReason === 'error' || sample.stopReason === 'aborted',
    ).length,
    averageTtftMs: divide(
      Array.reduce(ttfts, 0, (total, value) => total + value),
      ttfts.length,
    ),
    p50TtftMs: percentile(ttfts, 0.5),
    p95TtftMs: percentile(ttfts, 0.95),
    weightedTps: divide(measuredTokenIntervals * 1000, measuredGenerationMs),
    measuredTokenIntervals,
    measuredGenerationMs,
  }
}

export function makeSpeedTracker(now: () => number): SpeedTracker {
  const history = MutableList.make<SpeedSample>()
  let current: ActiveMeasurement | undefined
  let nextId = 1

  return {
    active: () => current,

    start: () => {
      if (!current) {
        current = { id: nextId++, requestAt: now() }
      }
      return current
    },

    markResponse: () => {
      if (!current) {
        return undefined
      }
      current = { ...current, responseAt: now() }
      return current
    },

    markFirstOutput: (kind) => {
      if (!current || current.firstOutputAt !== undefined) {
        return undefined
      }
      current = {
        ...current,
        firstOutputAt: now(),
        firstOutputKind: kind,
      }
      return current
    },

    finish: (completion) => {
      if (!current) {
        return undefined
      }

      const measurement = current
      const completedAt = now()
      current = undefined

      const outputTokens =
        globalThis.Number.isFinite(completion.outputTokens) &&
        completion.outputTokens > 0
          ? completion.outputTokens
          : 0
      const successful =
        completion.stopReason !== 'error' && completion.stopReason !== 'aborted'
      const ttftMs =
        measurement.firstOutputAt === undefined
          ? undefined
          : elapsed(measurement.requestAt, measurement.firstOutputAt)
      const generationMs =
        measurement.firstOutputAt === undefined
          ? undefined
          : elapsed(measurement.firstOutputAt, completedAt)
      const outputTps =
        successful && outputTokens > 1 && generationMs !== undefined
          ? divide((outputTokens - 1) * 1000, generationMs)
          : undefined

      const sample: SpeedSample = {
        id: measurement.id,
        provider: completion.provider,
        model: completion.model,
        stopReason: completion.stopReason,
        firstOutputKind: measurement.firstOutputKind,
        outputTokens,
        totalMs: elapsed(measurement.requestAt, completedAt),
        responseHeadersMs:
          measurement.responseAt === undefined
            ? undefined
            : elapsed(measurement.requestAt, measurement.responseAt),
        firstOutputAfterHeadersMs:
          measurement.responseAt === undefined ||
          measurement.firstOutputAt === undefined
            ? undefined
            : elapsed(measurement.responseAt, measurement.firstOutputAt),
        ttftMs,
        generationMs,
        outputTps,
      }

      MutableList.append(history, sample)
      return sample
    },

    abandon: () => {
      const hadActiveMeasurement = current !== undefined
      current = undefined
      return hadActiveMeasurement
    },

    samples: () => MutableList.toArray(history),

    resetHistory: () => MutableList.clear(history),

    resetSession: () => {
      current = undefined
      nextId = 1
      MutableList.clear(history)
    },
  }
}
