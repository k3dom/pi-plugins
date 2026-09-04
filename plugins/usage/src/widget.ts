import type { ClaudeUsage, UsageWindow } from './provider/anthropic'
import type { CodexUsage } from './provider/openai'
import { codexResetsAt, formatCompactDuration, parseResetsAt } from './reset'

export interface WidgetLimit {
  readonly label: string
  readonly percent: number
  readonly resetsAt?: Date | null | undefined
}

const BAR_WIDTH = 5

export function widgetText(
  limits: readonly WidgetLimit[] | undefined,
  now: Date,
): string | undefined {
  if (limits === undefined || limits.length === 0) {
    return undefined
  }
  return limits
    .map((limit) => {
      const clamped = Math.min(Math.max(limit.percent, 0), 100)
      const filled = Math.round((clamped / 100) * BAR_WIDTH)
      const bar = `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
      const text = `${limit.label} ${bar} ${Math.round(limit.percent)}%`
      if (!limit.resetsAt) {
        return text
      }
      const delta = limit.resetsAt.getTime() - now.getTime()
      return `${text} (${delta > 0 ? formatCompactDuration(delta) : 'now'})`
    })
    .join(' · ')
}

export function claudeWidgetLimits(usage: ClaudeUsage): WidgetLimit[] {
  const limits = usage.limits ?? []
  if (limits.length > 0) {
    return limits.flatMap((limit) => {
      const label =
        limit.kind === 'session'
          ? '5h'
          : limit.kind === 'weekly_all'
            ? 'wk'
            : undefined
      return label !== undefined && typeof limit.percent === 'number'
        ? [
            {
              label,
              percent: limit.percent,
              resetsAt: parseResetsAt(limit.resets_at),
            },
          ]
        : []
    })
  }

  const windows: [string, UsageWindow | null | undefined][] = [
    ['5h', usage.five_hour],
    ['wk', usage.seven_day],
  ]
  return windows.flatMap(([label, window]) =>
    typeof window?.utilization === 'number'
      ? [
          {
            label,
            percent: window.utilization,
            resetsAt: parseResetsAt(window.resets_at),
          },
        ]
      : [],
  )
}

export function codexWidgetLimits(usage: CodexUsage, now: Date): WidgetLimit[] {
  const details = usage.rate_limit
  return [details?.primary_window, details?.secondary_window].flatMap((window) => {
    if (!window) {
      return []
    }
    const seconds = window.limit_window_seconds
    const label =
      typeof seconds !== 'number' || seconds <= 0
        ? '?'
        : seconds >= 604_800 * 0.9
          ? 'wk'
          : seconds >= 86_400
            ? `${Math.round(seconds / 86_400)}d`
            : `${Math.round(seconds / 3600)}h`
    return [
      {
        label,
        percent: window.used_percent,
        resetsAt: codexResetsAt(window, now),
      },
    ]
  })
}
