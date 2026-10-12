import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  Array,
  DateTime,
  Duration,
  Match,
  Number,
  Option,
  Order,
  pipe,
  Predicate,
  Schema,
  SchemaGetter,
  String,
} from 'effect'
import * as Bar from './bar'
import type * as Anthropic from './provider/anthropic'
import * as OpenAI from './provider/openai'
import * as Zai from './provider/zai'

// e.g. default_claude_max_5x, default_claude_max_20x, default_claude_pro
const CLAUDE_PLAN_TIER = /^default_claude_(max|pro)(?:_(\d+x))?$/
const numberFormat = new Intl.NumberFormat('en-US')

// Truncated to whole milliseconds on encode, as the `Date` values stored by
// earlier versions were.
const EpochMillis = Schema.Number.pipe(
  Schema.decodeTo(Schema.DateTimeUtc, {
    decode: SchemaGetter.dateTimeUtcFromInput(),
    encode: SchemaGetter.transform((dateTime) =>
      Math.trunc(DateTime.toEpochMillis(dateTime)),
    ),
  }),
)

const Row = Schema.Struct({
  label: Schema.String,
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  // Only earlier versions stored null, for an invalid date.
  resetsAt: Schema.optional(Schema.NullOr(EpochMillis)),
  note: Schema.optional(Schema.String),
})
type Row = typeof Row.Type

const Section = Schema.Union([
  Schema.Struct({ title: Schema.String, rows: Schema.Array(Row) }),
  Schema.Struct({ title: Schema.String, error: Schema.String }),
])
export type Section = typeof Section.Type

/** Persisted as a session entry, so its encoded form must keep old sessions readable. */
export const Report = Schema.Struct({
  fetchedAt: EpochMillis,
  sections: Schema.Array(Section),
})
export type Report = typeof Report.Type

export function render(report: Report, theme: Theme): string {
  const labelWidth = pipe(
    report.sections,
    Array.flatMap((section) =>
      'rows' in section ? Array.map(section.rows, (row) => row.label.length) : [],
    ),
    Array.prepend(0),
    Array.max(Order.Number),
    Number.increment,
  )

  const lines = [
    theme.bold('Usage'),
    '',
    `${theme.fg('dim', 'Fetched:')} ${DateTime.formatLocal(report.fetchedAt, {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })}`,
  ]

  for (const section of report.sections) {
    lines.push('', theme.bold(section.title))
    if ('error' in section) {
      lines.push(theme.fg('warning', section.error))
      continue
    }
    if (!Array.isReadonlyArrayNonEmpty(section.rows)) {
      lines.push(theme.fg('dim', 'No usage data reported'))
      continue
    }
    for (const row of section.rows) {
      const details = Array.getSomes([
        pipe(
          Option.fromNullishOr(row.resetsAt),
          Option.map((resetsAt) => DateTime.distance(report.fetchedAt, resetsAt)),
          Option.map((delta) =>
            Duration.isPositive(delta)
              ? `resets in ${formatDuration(delta)}`
              : 'resets soon',
          ),
        ),
        pipe(Option.fromNullishOr(row.note), Option.filter(String.isNonEmpty)),
      ])

      const label = theme.fg('dim', String.padEnd(labelWidth)(`${row.label}:`))
      if (!Predicate.isNumber(row.percent)) {
        lines.push(`${label} ${Array.join(details, ', ')}`)
        continue
      }
      const percent = String.padStart(5)(`${Math.round(row.percent)}%`)
      const suffix = Array.isReadonlyArrayNonEmpty(details)
        ? ` ${theme.fg('dim', `(${Array.join(details, ', ')})`)}`
        : ''
      lines.push(`${label} [${Bar.render(row.percent, 10)}]${percent}${suffix}`)
    }
  }

  return pipe(lines, Array.join('\n'), String.trimEnd)
}

function formatDuration(duration: Duration.Duration): string {
  return Match.value(
    Duration.parts(Duration.minutes(Math.ceil(Duration.toMinutes(duration)))),
  ).pipe(
    Match.when(
      { days: Number.isGreaterThan(0) },
      ({ days, hours }) => `${days}d ${hours}h`,
    ),
    Match.when(
      { hours: Number.isGreaterThan(0) },
      ({ hours, minutes }) => `${hours}h ${minutes}m`,
    ),
    Match.orElse(({ minutes }) => `${minutes}m`),
  )
}

function unifiedLimitLabel(limit: Anthropic.UnifiedLimit): string {
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

function sectionTitle(
  name: string,
  plan: string | null | undefined,
  email: string | null | undefined,
): string {
  const title = plan ? `${name} (${plan})` : name
  return email ? `${title} — ${email}` : title
}

export function claudeSection({ usage, profile }: Anthropic.AccountUsage): Section {
  const limits = usage.limits ?? []
  // `is_active` marks the currently binding limit, not visibility, so every limit
  // is listed.
  const rows: Row[] = Array.isReadonlyArrayNonEmpty(limits)
    ? Array.map(limits, (limit) => ({
        label: unifiedLimitLabel(limit),
        percent: limit.percent,
        resetsAt: limit.resets_at ?? undefined,
      }))
    : Array.flatMap(
        [
          ['Session (5h)', usage.five_hour],
          ['Week (all models)', usage.seven_day],
          ['Week (Opus)', usage.seven_day_opus],
          ['Week (Sonnet)', usage.seven_day_sonnet],
        ] as const,
        ([label, window]) =>
          Predicate.isNumber(window?.utilization)
            ? [
                {
                  label,
                  percent: window.utilization,
                  resetsAt: window.resets_at ?? undefined,
                },
              ]
            : [],
      )

  const extra = usage.extra_usage
  if (extra) {
    const decimalPlaces = extra.decimal_places ?? 2
    const formatMinorAmount = (amount: number) => {
      const value = amount / 10 ** decimalPlaces
      return pipe(
        Option.fromNullishOr(extra.currency),
        Option.filter(String.isNonEmpty),
        // Throws for an unknown currency code.
        Option.flatMap(
          Option.liftThrowable((currency: string) =>
            new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(
              value,
            ),
          ),
        ),
        Option.getOrElse(() => value.toFixed(decimalPlaces)),
      )
    }
    const used = Option.map(
      Option.fromNullishOr(extra.used_credits),
      formatMinorAmount,
    )
    const monthlyLimit = Option.map(
      Option.fromNullishOr(extra.monthly_limit),
      formatMinorAmount,
    )
    if (Option.isSome(used)) {
      rows.push({
        label: 'Extra usage',
        percent: extra.utilization,
        note: Option.match(monthlyLimit, {
          onNone: () => used.value,
          onSome: (limit) => `${used.value} of ${limit}`,
        }),
      })
    }
    if (extra.is_enabled === false) {
      const reason = pipe(
        extra.disabled_reason ?? '',
        String.split('_'),
        Array.filter(String.isNonEmpty),
        Array.map(String.capitalize),
        Array.join(' '),
      )
      rows.push({
        label: 'Extra usage',
        note: String.isNonEmpty(reason) ? `disabled — ${reason}` : 'disabled',
      })
    }
  }

  const plan = Match.value(profile).pipe(
    Match.when(
      {
        organization: {
          rate_limit_tier: (tier: string) => CLAUDE_PLAN_TIER.test(tier),
        },
      },
      ({ organization }) => {
        const [, kind, multiplier] =
          organization.rate_limit_tier.match(CLAUDE_PLAN_TIER)!
        const name = kind === 'max' ? 'Max' : 'Pro'
        return multiplier ? `${name} ${multiplier}` : name
      },
    ),
    Match.when({ account: { has_claude_max: true } }, () => 'Max'),
    Match.when({ account: { has_claude_pro: true } }, () => 'Pro'),
    Match.orElse(() => undefined),
  )
  return { title: sectionTitle('Claude', plan, profile?.account?.email), rows }
}

function codexWindowRows(
  details: OpenAI.RateLimitDetails | null | undefined,
  now: DateTime.Utc,
  labelFor: (windowName: string) => string,
): Row[] {
  return pipe(
    [details?.primary_window, details?.secondary_window],
    Array.filter(Predicate.isNotNullish),
    Array.map((window) => ({
      label: labelFor(
        OpenAI.windowName(window, { unknown: 'Window', week: 'Week' }),
      ),
      percent: window.used_percent,
      resetsAt: Option.getOrUndefined(OpenAI.resetsAt(window, now)),
    })),
  )
}

export function codexSection(usage: OpenAI.Usage, now: DateTime.Utc): Section {
  const rows = Array.appendAll(
    codexWindowRows(usage.rate_limit, now, (name) => `${name} limit`),
    Array.flatMap(usage.additional_rate_limits ?? [], (additional) =>
      codexWindowRows(
        additional.rate_limit,
        now,
        (name) => `${additional.limit_name} (${name})`,
      ),
    ),
  )

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

  return {
    title: sectionTitle('OpenAI Codex', usage.plan_type, usage.email),
    rows,
  }
}

function glmRow(label: string, limit: Zai.QuotaLimit): Row {
  const unit = Match.value(limit.type).pipe(
    Match.when('CREDIT_LIMIT', () => 'credits'),
    Match.when('TIME_LIMIT', () => 'calls'),
    Match.orElse(() => 'tokens'),
  )
  return {
    label,
    percent: limit.percentage,
    resetsAt: limit.nextResetTime ?? undefined,
    note:
      Predicate.isNumber(limit.currentValue) &&
      Predicate.isNumber(limit.usage) &&
      limit.usage > 0
        ? `${numberFormat.format(limit.currentValue)} of ${numberFormat.format(limit.usage)} ${unit}`
        : undefined,
  }
}

export function glmSection(usage: Zai.Usage): Section {
  const rows = Array.appendAll(
    Array.zipWith(['Session (5h)', 'Week'], Zai.rateLimits(usage), glmRow),
    pipe(
      usage.limits ?? [],
      Array.findFirst((limit) => limit.type === 'TIME_LIMIT'),
      Option.map((limit) => glmRow('MCP tools (month)', limit)),
      Option.toArray,
    ),
  )
  const title = usage.level ? `GLM Coding (${usage.level})` : 'GLM Coding'
  return { title, rows }
}
