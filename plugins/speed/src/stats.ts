import { Array, Number, Order, pipe, Record } from 'effect'

/** One completed provider request measurement. */
export interface Sample {
  /** `provider/model-id` that produced the response. */
  readonly model: string
  /** Provider request sent → first streamed token, in ms. */
  readonly ttftMs: number
  /** First streamed token → end of message, in ms. */
  readonly generationMs: number
  /** Output tokens reported by the provider (includes reasoning tokens). */
  readonly outputTokens: number
  /** Unix timestamp (ms) when the sample was recorded. */
  readonly timestamp: number
}

/** Session aggregate for one model. */
export interface ModelStats {
  readonly model: string
  readonly requests: number
  /** Aggregate throughput: total tokens over total generation time. */
  readonly tps: number
  readonly totalTokens: number
  /** TTFT distribution (ms); the worse tail is the high end. */
  readonly ttft: TailSummary
  /** Per-request throughput distribution (tok/s); the worse tail is the low end. */
  readonly requestTps: TailSummary
}

/**
 * Tail statistics of one metric. Percentiles walk toward the *worse* tail
 * (high for latency, low for throughput), so e.g. `p95` for tok/s means
 * "95% of requests were at least this fast".
 */
export interface TailSummary {
  /** Median; undefined below 4 samples. */
  readonly p50: number | undefined
  /** 95th percentile toward the worse tail; undefined below 40 samples. */
  readonly p95: number | undefined
  /** Worst observed value (max for latency, min for throughput). */
  readonly worst: number
}

/**
 * A quantile is reported only when at least this many samples lie strictly
 * beyond its rank. This guarantees the value is genuinely interior —
 * separated from the displayed worst value by real observations — rather
 * than a relabeled (near-)max. Yields gates of n ≥ 4 for p50 and n ≥ 40
 * for p95.
 */
const MIN_SAMPLES_BEYOND = 2

/**
 * Nearest-rank quantile of a sorted array (worse tail last). Always returns
 * an observed value rather than an interpolated one; `NaN` when empty.
 */
export function quantile(sorted: readonly number[], q: number): number {
  const index = Math.min(
    Math.max(Math.ceil(q * sorted.length) - 1, 0),
    sorted.length - 1,
  )
  return sorted[index] ?? globalThis.Number.NaN
}

/** Quantile summary of `values`; `worse` selects which tail percentiles walk toward. */
export function tailSummary(
  values: readonly number[],
  worse: 'high' | 'low',
): TailSummary {
  // Sorted so the worse tail sits at the end; nearest-rank then treats
  // latency (worse = high) and throughput (worse = low) symmetrically.
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

/** Provider-reported throughput of a single request. */
export function tokensPerSecond(sample: Sample): number {
  return sample.outputTokens / (sample.generationMs / 1000)
}

/** Groups samples by model, most-used model first. */
export function aggregate(samples: readonly Sample[]): ModelStats[] {
  return pipe(
    Record.toEntries(Array.groupBy(samples, (sample) => sample.model)),
    Array.map(
      ([model, group]): ModelStats => ({
        model,
        requests: group.length,
        tps:
          Number.sumAll(group.map((sample) => sample.outputTokens)) /
          (Number.sumAll(group.map((sample) => sample.generationMs)) / 1000),
        totalTokens: Number.sumAll(group.map((sample) => sample.outputTokens)),
        ttft: tailSummary(
          group.map((sample) => sample.ttftMs),
          'high',
        ),
        requestTps: tailSummary(group.map(tokensPerSecond), 'low'),
      }),
    ),
    Array.sortWith((stats: ModelStats) => stats.requests, Order.flip(Order.Number)),
  )
}

/** "42.3", "128" — bare tok/s value for lines that carry the unit elsewhere. */
function formatTpsValue(tps: number): string {
  return tps >= 100 ? Math.round(tps).toString() : tps.toFixed(1)
}

/** "42.3 tok/s", "128 tok/s" */
export function formatTps(tps: number): string {
  return `${formatTpsValue(tps)} tok/s`
}

/** "830ms", "1.24s", "27.3s", "94s" */
export function formatMs(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`
  }
  const seconds = ms / 1000
  if (seconds < 10) {
    return `${seconds.toFixed(2)}s`
  }
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`
}

/** "845", "14.8k", "2.1M" */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

const TAIL_LABEL_WIDTH = 'tok/s'.length

/** `    TTFT   p50 830ms · p95 1.24s · max 2.10s` — gated quantiles plus the worst value. */
function tailLine(
  label: string,
  summary: TailSummary,
  format: (value: number) => string,
  worstLabel: 'max' | 'min',
): string {
  const parts = Array.filter(
    [
      summary.p50 === undefined ? undefined : `p50 ${format(summary.p50)}`,
      summary.p95 === undefined ? undefined : `p95 ${format(summary.p95)}`,
      `${worstLabel} ${format(summary.worst)}`,
    ],
    (part): part is string => part !== undefined,
  )
  return `    ${label.padEnd(TAIL_LABEL_WIDTH)}  ${parts.join(' · ')}`
}

/** Multi-line session report: last request plus per-model aggregates. */
export function renderReport(samples: readonly Sample[]): string {
  const last = samples.at(-1)
  if (last === undefined) {
    return 'No completed requests measured yet in this session.'
  }

  const stats = aggregate(samples)
  const labelWidth = Math.max(...stats.map((entry) => entry.model.length))

  return [
    `Inference speed — this session (${samples.length} request${samples.length === 1 ? '' : 's'})`,
    '',
    `Last request  ${last.model}`,
    `  ${formatTps(tokensPerSecond(last))} · TTFT ${formatMs(last.ttftMs)} · ${formatTokens(
      last.outputTokens,
    )} tok in ${formatMs(last.generationMs)}`,
    '',
    'Per model',
    ...stats.flatMap((entry) => [
      `  ${entry.model.padEnd(labelWidth)}  ${entry.requests} req · ${formatTps(
        entry.tps,
      )} · ${formatTokens(entry.totalTokens)} tok`,
      tailLine('TTFT', entry.ttft, formatMs, 'max'),
      tailLine('tok/s', entry.requestTps, formatTpsValue, 'min'),
    ]),
  ].join('\n')
}
