import type { FirstToken, RecentSpeed } from './service'

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

function recentTps(recent: RecentSpeed): string {
  // Two significant figures: the standard error is a few percent, so more digits
  // would be noise.
  const tps =
    recent.tps < 100 ? Math.round(recent.tps) : Math.round(recent.tps / 10) * 10
  return `${recent.provisional ? '~' : ''}${tps} tok/s`
}

export function recentText(recent: RecentSpeed): string {
  return `${recentTps(recent)} · TTFT ${formatMs(recent.ttftMs)}`
}

export function streamingText(
  recent: RecentSpeed | undefined,
  firstToken: FirstToken,
): string {
  const ttft = `TTFT ${formatMs(firstToken.ttftMs)}`
  return recent === undefined ? ttft : `${recentTps(recent)} · ${ttft}`
}
