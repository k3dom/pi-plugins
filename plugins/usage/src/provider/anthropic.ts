import { DateTime, Option, Predicate, Schema, SchemaTransformation } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

export const BASE_URL = 'https://api.anthropic.com'
export const OAUTH_BETA = 'oauth-2025-04-20'

// An ISO string or, as Claude Code assumes, epoch seconds. An unparseable string
// leaves the reset time out instead of failing the whole response.
const ResetsAt = Schema.Union([Schema.String, Schema.Number]).pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transformOptional<DateTime.Utc, string | number>({
      decode: Option.flatMap((value) =>
        Predicate.isNumber(value)
          ? Option.some(DateTime.fromEpochSeconds(value))
          : DateTime.make(value),
      ),
      encode: Option.map(DateTime.formatIso),
    }),
  ),
)

export const UsageWindow = Schema.Struct({
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(ResetsAt)),
})
export type UsageWindow = typeof UsageWindow.Type

export const UnifiedLimit = Schema.Struct({
  kind: Schema.String,
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(ResetsAt)),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              id: Schema.optional(Schema.NullOr(Schema.String)),
              display_name: Schema.optional(Schema.NullOr(Schema.String)),
            }),
          ),
        ),
      }),
    ),
  ),
  is_active: Schema.optional(Schema.NullOr(Schema.Boolean)),
})
export type UnifiedLimit = typeof UnifiedLimit.Type

export const Usage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(UsageWindow)),
  seven_day: Schema.optional(Schema.NullOr(UsageWindow)),
  seven_day_opus: Schema.optional(Schema.NullOr(UsageWindow)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(UsageWindow)),
  seven_day_oauth_apps: Schema.optional(Schema.NullOr(UsageWindow)),
  extra_usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        is_enabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
        monthly_limit: Schema.optional(Schema.NullOr(Schema.Number)),
        used_credits: Schema.optional(Schema.NullOr(Schema.Number)),
        utilization: Schema.optional(Schema.NullOr(Schema.Number)),
        currency: Schema.optional(Schema.NullOr(Schema.String)),
        decimal_places: Schema.optional(Schema.NullOr(Schema.Number)),
        disabled_reason: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  limits: Schema.optional(Schema.NullOr(Schema.Array(UnifiedLimit))),
})
export type Usage = typeof Usage.Type

export const Profile = Schema.Struct({
  account: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        email: Schema.optional(Schema.NullOr(Schema.String)),
        has_claude_max: Schema.optional(Schema.NullOr(Schema.Boolean)),
        has_claude_pro: Schema.optional(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
  organization: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.optional(Schema.NullOr(Schema.String)),
        organization_type: Schema.optional(Schema.NullOr(Schema.String)),
        rate_limit_tier: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
})
export type Profile = typeof Profile.Type

export interface AccountUsage {
  readonly usage: Usage
  readonly profile: Profile | undefined
}

export const UsageApi = HttpApi.make('ClaudeUsage').add(
  HttpApiGroup.make('oauth', { topLevel: true })
    .add(HttpApiEndpoint.get('usage', '/api/oauth/usage', { success: Usage }))
    .add(HttpApiEndpoint.get('profile', '/api/oauth/profile', { success: Profile })),
)
