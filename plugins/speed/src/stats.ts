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
  readonly avgTtftMs: number
  readonly totalTokens: number
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
        avgTtftMs:
          Number.sumAll(group.map((sample) => sample.ttftMs)) / group.length,
        totalTokens: Number.sumAll(group.map((sample) => sample.outputTokens)),
      }),
    ),
    Array.sortWith((stats: ModelStats) => stats.requests, Order.flip(Order.Number)),
  )
}

/** "42.3 tok/s", "128 tok/s" */
export function formatTps(tps: number): string {
  const value = tps >= 100 ? Math.round(tps).toString() : tps.toFixed(1)
  return `${value} tok/s`
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
    ...stats.map(
      (entry) =>
        `  ${entry.model.padEnd(labelWidth)}  ${entry.requests} req · ${formatTps(
          entry.tps,
        )} · avg TTFT ${formatMs(entry.avgTtftMs)} · ${formatTokens(entry.totalTokens)} tok`,
    ),
  ].join('\n')
}
