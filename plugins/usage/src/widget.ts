import type { ClaudeUsage, UsageWindow } from './provider/anthropic'
import type { CodexUsage } from './provider/openai'

/** One compact rate-limit entry shown on the shared status line. */
export interface WidgetLimit {
  /** Short window label, e.g. "5h" or "wk". */
  readonly label: string
  /** Percentage used, 0-100. */
  readonly percent: number
}

const BAR_WIDTH = 5

function bar(percent: number): string {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  return `${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}`
}

/** "5h ██░░░ 41% · wk ███░░ 62%", or `undefined` when there is nothing to show. */
export function widgetText(
  limits: readonly WidgetLimit[] | undefined,
): string | undefined {
  if (limits === undefined || limits.length === 0) {
    return undefined
  }
  return limits
    .map(({ label, percent }) => `${label} ${bar(percent)} ${Math.round(percent)}%`)
    .join(' · ')
}

// ─── Claude ──────────────────────────────────────────────────────────────────

/** Short label for a unified-limit kind; model-scoped weekly limits are skipped. */
function claudeLimitLabel(kind: string): string | undefined {
  switch (kind) {
    case 'session':
      return '5h'
    case 'weekly_all':
      return 'wk'
    default:
      return undefined
  }
}

export function claudeWidgetLimits(usage: ClaudeUsage): WidgetLimit[] {
  const limits = usage.limits ?? []
  if (limits.length > 0) {
    // The unified `limits` array supersedes the flat windows when present.
    return limits.flatMap((limit) => {
      const label = claudeLimitLabel(limit.kind)
      return label !== undefined && typeof limit.percent === 'number'
        ? [{ label, percent: limit.percent }]
        : []
    })
  }

  const windows: [string, UsageWindow | null | undefined][] = [
    ['5h', usage.five_hour],
    ['wk', usage.seven_day],
  ]
  return windows.flatMap(([label, window]) =>
    typeof window?.utilization === 'number'
      ? [{ label, percent: window.utilization }]
      : [],
  )
}

// ─── OpenAI Codex ────────────────────────────────────────────────────────────

function codexWindowLabel(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) {
    return '?'
  }
  if (seconds >= 604_800 * 0.9) {
    return 'wk'
  }
  if (seconds >= 86_400) {
    return `${Math.round(seconds / 86_400)}d`
  }
  return `${Math.round(seconds / 3600)}h`
}

export function codexWidgetLimits(usage: CodexUsage): WidgetLimit[] {
  const details = usage.rate_limit
  return [details?.primary_window, details?.secondary_window].flatMap((window) =>
    window
      ? [
          {
            label: codexWindowLabel(window.limit_window_seconds),
            percent: window.used_percent,
          },
        ]
      : [],
  )
}
