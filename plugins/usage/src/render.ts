import type { ClaudeUsage, UsageWindow } from './provider/anthropic'
import type { CodexUsage, RateLimitDetails } from './provider/openai'
import { codexResetsAt, formatDuration, parseResetsAt } from './reset'

const MIN_LABEL_WIDTH = 22
const BAR_WIDTH = 10

export interface UsageRow {
  readonly label: string
  readonly percent?: number | null | undefined
  readonly resetsAt?: Date | null | undefined
  readonly note?: string | undefined
}

export type UsageSection =
  | { readonly title: string; readonly rows: readonly UsageRow[] }
  | { readonly title: string; readonly error: string }

export function renderSections(
  sections: readonly UsageSection[],
  now: Date,
): string[] {
  const labelWidth = Math.max(
    MIN_LABEL_WIDTH,
    ...sections.flatMap((section) =>
      'rows' in section ? section.rows.map((row) => row.label.length) : [],
    ),
  )
  return sections.map((section) => {
    if ('error' in section) {
      return `${section.title}\n  ${section.error}`
    }
    if (section.rows.length === 0) {
      return `${section.title}\n  (no usage data reported)`
    }
    const lines = section.rows.map((row) => {
      const parts = [`  ${row.label.padEnd(labelWidth)}`]

      if (typeof row.percent === 'number') {
        const clamped = Math.min(Math.max(row.percent, 0), 100)
        const filled = Math.round((clamped / 100) * BAR_WIDTH)
        parts.push(
          `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`,
          `${Math.round(row.percent)}%`.padStart(4),
        )
      }

      if (row.resetsAt) {
        const delta = row.resetsAt.getTime() - now.getTime()
        parts.push(
          delta > 0 ? `· resets in ${formatDuration(delta)}` : '· resets soon',
        )
      }

      if (row.note) {
        parts.push(parts.length > 1 ? `· ${row.note}` : row.note)
      }

      return parts.join(' ')
    })
    return [section.title, ...lines].join('\n')
  })
}

function formatMinorAmount(
  amount: number,
  decimalPlaces: number,
  currency: string | null | undefined,
): string {
  const value = amount / 10 ** decimalPlaces
  if (currency) {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
        value,
      )
    } catch {
      // Unknown currency code.
    }
  }
  return value.toFixed(decimalPlaces)
}

export function claudeSection(usage: ClaudeUsage): UsageSection {
  const rows: UsageRow[] = []

  const limits = usage.limits ?? []
  if (limits.length > 0) {
    // `is_active` marks the currently binding limit, not visibility, so every
    // limit is listed.
    for (const limit of limits) {
      let label: string
      switch (limit.kind) {
        case 'session':
          label = 'Session (5h)'
          break
        case 'weekly_all':
          label = 'Week (all models)'
          break
        case 'weekly_scoped': {
          const model = limit.scope?.model
          label = `Week (${model?.display_name ?? model?.id ?? 'scoped'})`
          break
        }
        default:
          label = limit.kind
      }
      rows.push({
        label,
        percent: limit.percent,
        resetsAt: parseResetsAt(limit.resets_at),
      })
    }
  } else {
    const flatWindows: [string, UsageWindow | null | undefined][] = [
      ['Session (5h)', usage.five_hour],
      ['Week (all models)', usage.seven_day],
      ['Week (Opus)', usage.seven_day_opus],
      ['Week (Sonnet)', usage.seven_day_sonnet],
    ]
    for (const [label, window] of flatWindows) {
      if (window && typeof window.utilization === 'number') {
        rows.push({
          label,
          percent: window.utilization,
          resetsAt: parseResetsAt(window.resets_at),
        })
      }
    }
  }

  const extra = usage.extra_usage
  if (extra) {
    const decimals = extra.decimal_places ?? 2
    const used =
      typeof extra.used_credits === 'number'
        ? formatMinorAmount(extra.used_credits, decimals, extra.currency)
        : null
    const limit =
      typeof extra.monthly_limit === 'number'
        ? formatMinorAmount(extra.monthly_limit, decimals, extra.currency)
        : null
    if (used !== null) {
      rows.push({
        label: 'Extra usage',
        percent: extra.utilization,
        note: limit ? `${used} of ${limit}` : used,
      })
    }
    if (extra.is_enabled === false) {
      const reason = extra.disabled_reason
        ?.split('_')
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ')
      rows.push({
        label: 'Extra usage',
        note: reason ? `disabled — ${reason}` : 'disabled',
      })
    }
  }

  return { title: 'Claude', rows }
}

function codexWindowRows(
  details: RateLimitDetails | null | undefined,
  now: Date,
  labelFor: (windowName: string) => string,
): UsageRow[] {
  const rows: UsageRow[] = []
  for (const window of [details?.primary_window, details?.secondary_window]) {
    if (!window) {
      continue
    }
    const seconds = window.limit_window_seconds
    const name =
      typeof seconds !== 'number' || seconds <= 0
        ? 'Window'
        : seconds >= 604_800 * 0.9
          ? 'Week'
          : seconds >= 86_400
            ? `${Math.round(seconds / 86_400)}d`
            : `${Math.round(seconds / 3600)}h`
    rows.push({
      label: labelFor(name),
      percent: window.used_percent,
      resetsAt: codexResetsAt(window, now),
    })
  }
  return rows
}

export function codexSection(usage: CodexUsage, now: Date): UsageSection {
  const rows: UsageRow[] = codexWindowRows(usage.rate_limit, now, (name) =>
    name === 'Week' ? 'Week limit' : `${name} limit`,
  )

  for (const additional of usage.additional_rate_limits ?? []) {
    rows.push(
      ...codexWindowRows(
        additional.rate_limit,
        now,
        (name) => `${additional.limit_name} (${name})`,
      ),
    )
  }

  const credits = usage.credits
  if (
    credits &&
    (credits.unlimited || (credits.has_credits && credits.balance != null))
  ) {
    rows.push({
      label: 'Credits',
      note: credits.unlimited ? 'unlimited' : `balance ${credits.balance}`,
    })
  }

  const resetCredits = usage.rate_limit_reset_credits
  if (resetCredits && resetCredits.available_count > 0) {
    rows.push({
      label: 'Rate-limit resets',
      note: `${resetCredits.available_count} available`,
    })
  }

  const title = usage.plan_type
    ? `OpenAI Codex (${usage.plan_type})`
    : 'OpenAI Codex'
  return { title, rows }
}
