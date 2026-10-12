import { Duration, Match, Number, Option } from 'effect'
import type * as Tracker from './tracker'

function formatDuration(duration: Duration.Duration): string {
  const ms = Duration.toMillis(duration)
  return Match.value(ms / 1000).pipe(
    Match.when(Number.isLessThan(1), () => `${Math.round(ms)}ms`),
    Match.when(Number.isLessThan(10), (seconds) => `${seconds.toFixed(2)}s`),
    Match.when(Number.isLessThan(60), (seconds) => `${seconds.toFixed(1)}s`),
    Match.orElse((seconds) => `${Math.round(seconds)}s`),
  )
}

function rate(speed: Tracker.RecentSpeed): string {
  const tps =
    speed.tps < 100 ? Math.round(speed.tps) : Math.round(speed.tps / 10) * 10
  return `~${tps} tok/s`
}

export function recentText(
  recent: Option.Option<Tracker.RecentSpeed>,
): Option.Option<string> {
  return Option.map(
    recent,
    (speed) => `${rate(speed)} · TTFT ${formatDuration(speed.ttft)}`,
  )
}

export function streamingText(
  recent: Option.Option<Tracker.RecentSpeed>,
  ttft: Duration.Duration,
): string {
  return Option.match(recent, {
    onNone: () => `TTFT ${formatDuration(ttft)}`,
    onSome: (speed) => `${rate(speed)} · TTFT ${formatDuration(ttft)}`,
  })
}
