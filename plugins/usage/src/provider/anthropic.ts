import { Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
export const ANTHROPIC_OAUTH_BETA = 'oauth-2025-04-20'

export const UsageWindow = S.Struct({
  utilization: S.optional(S.NullOr(S.Number)),
  resets_at: S.optional(S.NullOr(S.String)),
})
export type UsageWindow = typeof UsageWindow.Type

export const ExtraUsage = S.Struct({
  is_enabled: S.optional(S.NullOr(S.Boolean)),
  monthly_limit: S.optional(S.NullOr(S.Number)),
  used_credits: S.optional(S.NullOr(S.Number)),
  utilization: S.optional(S.NullOr(S.Number)),
  currency: S.optional(S.NullOr(S.String)),
  decimal_places: S.optional(S.NullOr(S.Number)),
  disabled_reason: S.optional(S.NullOr(S.String)),
})
export type ExtraUsage = typeof ExtraUsage.Type

export const UnifiedLimit = S.Struct({
  kind: S.String,
  percent: S.optional(S.NullOr(S.Number)),
  resets_at: S.optional(S.NullOr(S.Union([S.String, S.Number]))),
  scope: S.optional(
    S.NullOr(
      S.Struct({
        model: S.optional(
          S.NullOr(
            S.Struct({
              id: S.optional(S.NullOr(S.String)),
              display_name: S.optional(S.NullOr(S.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  is_active: S.optional(S.NullOr(S.Boolean)),
})
export type UnifiedLimit = typeof UnifiedLimit.Type

export const ClaudeUsage = S.Struct({
  five_hour: S.optional(S.NullOr(UsageWindow)),
  seven_day: S.optional(S.NullOr(UsageWindow)),
  seven_day_opus: S.optional(S.NullOr(UsageWindow)),
  seven_day_sonnet: S.optional(S.NullOr(UsageWindow)),
  seven_day_oauth_apps: S.optional(S.NullOr(UsageWindow)),
  extra_usage: S.optional(S.NullOr(ExtraUsage)),
  limits: S.optional(S.NullOr(S.Array(UnifiedLimit))),
})
export type ClaudeUsage = typeof ClaudeUsage.Type

export const ClaudeUsageApi = HttpApi.make('ClaudeUsage').add(
  HttpApiGroup.make('oauth', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/api/oauth/usage', { success: ClaudeUsage }),
  ),
)
