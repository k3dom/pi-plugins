import { Array } from 'effect'
import {
  tokensPerSecond,
  type FirstToken,
  type Sample,
  type SessionReport,
  type TailSummary,
} from './service'

/** "42.3", "128" — bare value for lines that carry the tok/s unit elsewhere. */
function formatTpsValue(tps: number): string {
  return tps >= 100 ? Math.round(tps).toString() : tps.toFixed(1)
}

/** "42.3 tok/s", "128 tok/s" */
function formatTps(tps: number): string {
  return `${formatTpsValue(tps)} tok/s`
}

/** "830ms", "1.24s", "27.3s", "94s" */
function formatMs(ms: number): string {
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
function formatTokens(tokens: number): string {
  if (tokens < 1000) {
    return `${tokens}`
  }
  if (tokens < 1_000_000) {
    return `${(tokens / 1000).toFixed(1)}k`
  }
  return `${(tokens / 1_000_000).toFixed(1)}M`
}

/** Widget line for a completed measurement. */
export function sampleText(sample: Sample): string {
  return `${formatTps(tokensPerSecond(sample))} · TTFT ${formatMs(sample.ttftMs)}`
}

/**
 * Widget line while streaming: only the measured TTFT. Tokens/sec is shown
 * once the request completes and the provider reports real token counts.
 */
export function firstTokenText(firstToken: FirstToken): string {
  return `TTFT ${formatMs(firstToken.ttftMs)}`
}

const TAIL_LABEL_WIDTH = 'tok/s'.length

/** `    TTFT   p50 830ms · p95 1.24s · max 2.10s` */
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
export function renderReport(report: SessionReport): string {
  const { last, requestCount, stats } = report
  if (last === undefined) {
    return 'No completed requests measured yet in this session.'
  }

  const labelWidth = Math.max(...stats.map((entry) => entry.model.length))

  return [
    `Inference speed — this session (${requestCount} request${requestCount === 1 ? '' : 's'})`,
    '',
    `Last request  ${last.model}`,
    `  ${sampleText(last)} · ${formatTokens(last.outputTokens)} tok in ${formatMs(
      last.generationMs,
    )}`,
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
