import {
  Array,
  DateTime,
  Duration,
  Match,
  Number,
  Option,
  pipe,
  Predicate,
} from 'effect'
import * as Bar from './bar'
import type * as Anthropic from './provider/anthropic'
import * as OpenAI from './provider/openai'
import * as Zai from './provider/zai'

export interface Limit {
  readonly label: string
  readonly percent: number
  readonly resetsAt?: DateTime.Utc | null | undefined
}

export function text(limits: ReadonlyArray<Limit>, now: DateTime.Utc): string {
  return pipe(
    limits,
    Array.map((limit) => {
      const usage = `${limit.label} ${Bar.render(limit.percent, 5)} ${Math.round(limit.percent)}%`
      if (!limit.resetsAt) {
        return usage
      }
      const delta = DateTime.distance(now, limit.resetsAt)
      return `${usage} (${Duration.isPositive(delta) ? formatDuration(delta) : 'now'})`
    }),
    Array.join(' · '),
  )
}

function formatDuration(duration: Duration.Duration): string {
  return Match.value(Duration.parts(duration)).pipe(
    Match.when({ days: Number.isGreaterThan(0) }, ({ days }) => `${days}d`),
    Match.when(
      { hours: Number.isGreaterThan(0) },
      ({ hours, minutes }) => `${hours}h${minutes}m`,
    ),
    Match.orElse(({ minutes }) => `${Number.max(minutes, 1)}m`),
  )
}

export function claudeLimits(usage: Anthropic.Usage): Limit[] {
  const limits = usage.limits ?? []
  if (Array.isReadonlyArrayNonEmpty(limits)) {
    return Array.flatMap(limits, (limit) => {
      const label = Match.value(limit.kind).pipe(
        Match.when('session', () => '5h'),
        Match.when('weekly_all', () => 'wk'),
        Match.option,
      )
      return Option.isSome(label) && Predicate.isNumber(limit.percent)
        ? [{ label: label.value, percent: limit.percent, resetsAt: limit.resets_at }]
        : []
    })
  }

  return Array.flatMap(
    [
      ['5h', usage.five_hour],
      ['wk', usage.seven_day],
    ] as const,
    ([label, window]) =>
      Predicate.isNumber(window?.utilization)
        ? [{ label, percent: window.utilization, resetsAt: window.resets_at }]
        : [],
  )
}

export function codexLimits(usage: OpenAI.Usage, now: DateTime.Utc): Limit[] {
  return pipe(
    [usage.rate_limit?.primary_window, usage.rate_limit?.secondary_window],
    Array.filter(Predicate.isNotNullish),
    Array.map((window) => ({
      label: OpenAI.windowName(window, { unknown: '?', week: 'wk' }),
      percent: window.used_percent,
      resetsAt: Option.getOrUndefined(OpenAI.resetsAt(window, now)),
    })),
  )
}

export function glmLimits(usage: Zai.Usage): Limit[] {
  return Array.flatMap(
    Array.zip(['5h', 'wk'], Zai.rateLimits(usage)),
    ([label, limit]) =>
      Predicate.isNumber(limit.percentage)
        ? [{ label, percent: limit.percentage, resetsAt: limit.nextResetTime }]
        : [],
  )
}
