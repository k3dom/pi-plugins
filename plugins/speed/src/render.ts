import { Array } from 'effect'
import { summarize, type SpeedSample } from './metrics'

const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })

export function formatLatency(ms: number | undefined): string {
  if (ms === undefined || !globalThis.Number.isFinite(ms)) {
    return 'n/a'
  }
  if (ms < 1_000) {
    return `${Math.round(ms)}ms`
  }
  if (ms < 10_000) {
    return `${(ms / 1_000).toFixed(2)}s`
  }
  return `${(ms / 1_000).toFixed(1)}s`
}

export function formatTps(tps: number | undefined): string {
  return tps === undefined || !globalThis.Number.isFinite(tps)
    ? 'n/a'
    : `${tps.toFixed(1)} tok/s`
}

function stopReason(reason: SpeedSample['stopReason']): string {
  switch (reason) {
    case 'stop':
      return 'complete'
    case 'length':
      return 'length limit'
    case 'toolUse':
      return 'tool use'
    case 'error':
      return 'error'
    case 'aborted':
      return 'aborted'
  }
}

export function renderPendingStatus(): string {
  return 'speed: waiting for first token…'
}

export function renderStreamingStatus(ttftMs: number): string {
  return `speed: TTFT ${formatLatency(ttftMs)} · streaming`
}

export function renderSampleStatus(sample: SpeedSample): string {
  if (sample.stopReason === 'error' || sample.stopReason === 'aborted') {
    return `speed: ${stopReason(sample.stopReason)} · TTFT ${formatLatency(sample.ttftMs)}`
  }
  return `speed: ${formatTps(sample.outputTps)} · TTFT ${formatLatency(sample.ttftMs)}`
}

function renderSample(sample: SpeedSample): string[] {
  const details = [
    `  TTFT ${formatLatency(sample.ttftMs)} · TPS ${formatTps(sample.outputTps)} · total ${formatLatency(sample.totalMs)}`,
    `  ${integer.format(sample.outputTokens)} output tokens · generation ${formatLatency(sample.generationMs)} · ${stopReason(sample.stopReason)} · first ${sample.firstOutputKind ?? 'n/a'}`,
  ]

  if (sample.responseHeadersMs !== undefined) {
    details.push(
      `  response headers ${formatLatency(sample.responseHeadersMs)} · headers to first output ${formatLatency(sample.firstOutputAfterHeadersMs)}`,
    )
  }

  return [`Last call — #${sample.id} ${sample.provider}/${sample.model}`, ...details]
}

export function renderReport(samples: readonly SpeedSample[]): string {
  return Array.match(samples, {
    onEmpty: () =>
      'No inference speed samples yet. Send a prompt and wait for the response to finish.',
    onNonEmpty: (nonEmpty) => {
      const last = Array.getUnsafe(nonEmpty, nonEmpty.length - 1)
      const sameModel = Array.filter(
        nonEmpty,
        (sample) => sample.provider === last.provider && sample.model === last.model,
      )
      const summary = summarize(sameModel)
      const failures =
        summary.failedCalls > 0 ? ` · ${summary.failedCalls} failed` : ''

      return [
        ...renderSample(last),
        '',
        `For ${last.provider}/${last.model} since session load`,
        `  ${summary.calls} calls · ${summary.measuredCalls} with TPS${failures}`,
        `  TTFT (${summary.ttftCalls} calls) avg ${formatLatency(summary.averageTtftMs)} · p50 ${formatLatency(summary.p50TtftMs)} · p95 ${formatLatency(summary.p95TtftMs)}`,
        `  Weighted TPS ${formatTps(summary.weightedTps)} · ${integer.format(summary.measuredTokenIntervals)} measured token intervals`,
      ].join('\n')
    },
  })
}

export function renderRecent(samples: readonly SpeedSample[], limit = 10): string {
  return Array.match(Array.reverse(Array.takeRight(samples, limit)), {
    onEmpty: () => 'No inference speed samples yet.',
    onNonEmpty: (recent) =>
      [
        `Recent inference calls (${recent.length})`,
        ...Array.map(
          recent,
          (sample) =>
            `  #${sample.id} ${sample.provider}/${sample.model} · TTFT ${formatLatency(sample.ttftMs)} · ${formatTps(sample.outputTps)} · ${integer.format(sample.outputTokens)} out · ${stopReason(sample.stopReason)}`,
        ),
      ].join('\n'),
  })
}
