import type { Theme } from '@earendil-works/pi-coding-agent'
import { Array } from 'effect'
import type { ClaudeUsage, UnifiedLimit, UsageWindow } from './provider/anthropic'
import type { CodexUsage, RateLimitDetails } from './provider/openai'
import { glmRateLimits, type GlmUsage, type QuotaLimit } from './provider/zai'
import { codexResetsAt, formatDuration, parseResetsAt } from './reset'

const BAR_WIDTH = 10
const numberFormat = new Intl.NumberFormat('en-US')

export interface UsageRow {
  readonly label: string
  readonly percent?: number | null | undefined
  readonly resetsAt?: number | null | undefined
  readonly note?: string | undefined
}

export type UsageSection =
  | { readonly title: string; readonly rows: readonly UsageRow[] }
  | { readonly title: string; readonly error: string }

export interface UsageReport {
  readonly fetchedAt: number
  readonly sections: readonly UsageSection[]
}

export function renderReport(report: UsageReport, theme: Theme): string {
  const labelWidth =
    Math.max(
      0,
      ...report.sections.flatMap((section) =>
        'rows' in section ? section.rows.map((row) => row.label.length) : [],
      ),
    ) + 1

  let info = `${theme.bold('Usage')}\n\n`
  info += `${theme.fg('dim', 'Fetched:')} ${new Date(report.fetchedAt).toLocaleString()}\n`

  for (const section of report.sections) {
    info += `\n${theme.bold(section.title)}\n`
    if ('error' in section) {
      info += `${theme.fg('warning', section.error)}\n`
      continue
    }
    if (section.rows.length === 0) {
      info += `${theme.fg('dim', 'No usage data reported')}\n`
      continue
    }
    for (const row of section.rows) {
      const details: string[] = []
      if (row.resetsAt) {
        const delta = row.resetsAt - report.fetchedAt
        details.push(
          delta > 0 ? `resets in ${formatDuration(delta)}` : 'resets soon',
        )
      }
      if (row.note) {
        details.push(row.note)
      }

      info += theme.fg('dim', `${row.label}:`.padEnd(labelWidth))
      if (typeof row.percent === 'number') {
        const clamped = Math.min(Math.max(row.percent, 0), 100)
        const filled = Math.round((clamped / 100) * BAR_WIDTH)
        info += ` [${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`
        info += `${Math.round(row.percent)}%`.padStart(5)
        if (details.length > 0) {
          info += ` ${theme.fg('dim', `(${details.join(', ')})`)}`
        }
      } else {
        info += ` ${details.join(', ')}`
      }
      info += '\n'
    }
  }

  return info.trimEnd()
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

function unifiedLimitLabel(limit: UnifiedLimit): string {
  switch (limit.kind) {
    case 'session':
      return 'Session (5h)'
    case 'weekly_all':
      return 'Week (all models)'
    case 'weekly_scoped': {
      const model = limit.scope?.model
      return `Week (${model?.display_name ?? model?.id ?? 'scoped'})`
    }
    default:
      return limit.kind
  }
}

export function claudeSection(usage: ClaudeUsage): UsageSection {
  const rows: UsageRow[] = []

  const limits = usage.limits ?? []
  if (limits.length > 0) {
    // `is_active` marks the currently binding limit, not visibility, so every
    // limit is listed.
    for (const limit of limits) {
      rows.push({
        label: unifiedLimitLabel(limit),
        percent: limit.percent,
        resetsAt: parseResetsAt(limit.resets_at)?.getTime(),
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
          resetsAt: parseResetsAt(window.resets_at)?.getTime(),
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

function codexWindowName(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || seconds <= 0) {
    return 'Window'
  }
  if (seconds >= 604_800 * 0.9) {
    return 'Week'
  }
  if (seconds >= 86_400) {
    return `${Math.round(seconds / 86_400)}d`
  }
  return `${Math.round(seconds / 3600)}h`
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
    rows.push({
      label: labelFor(codexWindowName(window.limit_window_seconds)),
      percent: window.used_percent,
      resetsAt: codexResetsAt(window, now)?.getTime(),
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

function glmRow(label: string, limit: QuotaLimit): UsageRow {
  const unit =
    limit.type === 'CREDIT_LIMIT'
      ? 'credits'
      : limit.type === 'TIME_LIMIT'
        ? 'calls'
        : 'tokens'
  return {
    label,
    percent: limit.percentage,
    resetsAt: limit.nextResetTime?.getTime(),
    note:
      typeof limit.currentValue === 'number' &&
      typeof limit.usage === 'number' &&
      limit.usage > 0
        ? `${numberFormat.format(limit.currentValue)} of ${numberFormat.format(limit.usage)} ${unit}`
        : undefined,
  }
}

export function glmSection(usage: GlmUsage): UsageSection {
  const rows = Array.zipWith(['Session (5h)', 'Week'], glmRateLimits(usage), glmRow)

  const mcp = usage.limits?.find((limit) => limit.type === 'TIME_LIMIT')
  if (mcp) {
    rows.push(glmRow('MCP tools (month)', mcp))
  }

  const title = usage.level ? `GLM Coding (${usage.level})` : 'GLM Coding'
  return { title, rows }
}
