import type { ClaudeUsage, UnifiedLimit, UsageWindow } from './provider/anthropic'
import type { CodexUsage, RateLimitDetails } from './provider/openai'

const MIN_LABEL_WIDTH = 22
const BAR_WIDTH = 10

export interface UsageRow {
  readonly label: string
  /** Percentage used, 0-100. */
  readonly percent?: number | null | undefined
  readonly resetsAt?: Date | null | undefined
  /** Free-form suffix (used instead of / in addition to the bar). */
  readonly note?: string | undefined
}

/** One provider block of the report: usage rows, or an inline failure. */
export type UsageSection =
  | { readonly title: string; readonly rows: readonly UsageRow[] }
  | { readonly title: string; readonly error: string }

function bar(percent: number): string {
  const clamped = Math.min(Math.max(percent, 0), 100)
  const filled = Math.round((clamped / 100) * BAR_WIDTH)
  return `[${'█'.repeat(filled)}${'░'.repeat(BAR_WIDTH - filled)}]`
}

/** "42m", "2h 13m", "4d 2h" */
export function formatDuration(ms: number): string {
  const minutes = Math.max(Math.ceil(ms / 60_000), 0)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h ${minutes % 60}m`
  }
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

function formatRow(row: UsageRow, now: Date, labelWidth: number): string {
  const parts = [`  ${row.label.padEnd(labelWidth)}`]

  if (typeof row.percent === 'number') {
    parts.push(bar(row.percent), `${Math.round(row.percent)}%`.padStart(4))
  }

  if (row.resetsAt) {
    const delta = row.resetsAt.getTime() - now.getTime()
    parts.push(delta > 0 ? `· resets in ${formatDuration(delta)}` : '· resets soon')
  }

  if (row.note) {
    // Separate the note from a preceding bar/percent or reset, but keep
    // note-only rows (e.g. "disabled — …") unprefixed.
    parts.push(parts.length > 1 ? `· ${row.note}` : row.note)
  }

  return parts.join(' ')
}

function renderSection(
  section: UsageSection,
  now: Date,
  labelWidth: number,
): string[] {
  if ('error' in section) {
    return [section.title, `  ${section.error}`]
  }
  if (section.rows.length === 0) {
    return [section.title, '  (no usage data reported)']
  }
  return [
    section.title,
    ...section.rows.map((row) => formatRow(row, now, labelWidth)),
  ]
}

/**
 * Renders each section to its own string, using a shared label width so bars
 * and percentages line up across providers, not just within one section.
 */
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
  return sections.map((section) =>
    renderSection(section, now, labelWidth).join('\n'),
  )
}

// ─── Claude ──────────────────────────────────────────────────────────────────

function parseResetsAt(value: string | number | null | undefined): Date | null {
  if (typeof value === 'number') {
    return new Date(value * 1000)
  }
  if (typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date
  }
  return null
}

function windowRow(
  label: string,
  window: UsageWindow | null | undefined,
): UsageRow | null {
  if (!window || typeof window.utilization !== 'number') {
    return null
  }
  return {
    label,
    percent: window.utilization,
    resetsAt: parseResetsAt(window.resets_at),
  }
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

/** "out_of_credit" -> "Out Of Credit" */
function formatIdentifier(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
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
      // Unknown currency code — fall through to the plain rendering.
    }
  }
  return value.toFixed(decimalPlaces)
}

export function claudeSection(usage: ClaudeUsage): UsageSection {
  const rows: UsageRow[] = []

  const limits = usage.limits ?? []
  if (limits.length > 0) {
    // The unified `limits` array supersedes the flat windows when present.
    // Note: `is_active` marks the currently binding limit, not visibility.
    for (const limit of limits) {
      rows.push({
        label: unifiedLimitLabel(limit),
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
      const row = windowRow(label, window)
      if (row) {
        rows.push(row)
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
      rows.push({
        label: 'Extra usage',
        note: extra.disabled_reason
          ? `disabled — ${formatIdentifier(extra.disabled_reason)}`
          : 'disabled',
      })
    }
  }

  return { title: 'Claude', rows }
}

// ─── OpenAI Codex ────────────────────────────────────────────────────────────

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

function codexResetsAt(
  window: { reset_after_seconds?: number | null; reset_at?: number | null },
  now: Date,
): Date | null {
  if (typeof window.reset_after_seconds === 'number') {
    return new Date(now.getTime() + window.reset_after_seconds * 1000)
  }
  if (typeof window.reset_at === 'number') {
    return new Date(window.reset_at * 1000)
  }
  return null
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
