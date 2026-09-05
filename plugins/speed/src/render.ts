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
  const tps =
    recent.tps < 100 ? Math.round(recent.tps) : Math.round(recent.tps / 10) * 10
  return `~${tps} tok/s`
}

export function recentText(recent: RecentSpeed | undefined): string | undefined {
  return recent === undefined
    ? undefined
    : `${recentTps(recent)} · TTFT ${formatMs(recent.ttftMs)}`
}

export function streamingText(
  recent: RecentSpeed | undefined,
  firstToken: FirstToken,
): string {
  const ttft = `TTFT ${formatMs(firstToken.ttftMs)}`
  return recent === undefined ? ttft : `${recentTps(recent)} · ${ttft}`
}
