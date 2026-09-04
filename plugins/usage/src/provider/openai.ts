import { Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

export const CHATGPT_BASE_URL = 'https://chatgpt.com'

export const RateLimitWindow = S.Struct({
  used_percent: S.Number,
  limit_window_seconds: S.optional(S.NullOr(S.Number)),
  reset_after_seconds: S.optional(S.NullOr(S.Number)),
  reset_at: S.optional(S.NullOr(S.Number)),
})
export type RateLimitWindow = typeof RateLimitWindow.Type

export const RateLimitDetails = S.Struct({
  allowed: S.optional(S.NullOr(S.Boolean)),
  limit_reached: S.optional(S.NullOr(S.Boolean)),
  primary_window: S.optional(S.NullOr(RateLimitWindow)),
  secondary_window: S.optional(S.NullOr(RateLimitWindow)),
})
export type RateLimitDetails = typeof RateLimitDetails.Type

export const CreditStatus = S.Struct({
  has_credits: S.optional(S.NullOr(S.Boolean)),
  unlimited: S.optional(S.NullOr(S.Boolean)),
  balance: S.optional(S.NullOr(S.String)),
})
export type CreditStatus = typeof CreditStatus.Type

export const AdditionalRateLimit = S.Struct({
  limit_name: S.String,
  rate_limit: S.optional(S.NullOr(RateLimitDetails)),
})
export type AdditionalRateLimit = typeof AdditionalRateLimit.Type

export const CodexUsage = S.Struct({
  plan_type: S.optional(S.NullOr(S.String)),
  rate_limit: S.optional(S.NullOr(RateLimitDetails)),
  credits: S.optional(S.NullOr(CreditStatus)),
  additional_rate_limits: S.optional(S.NullOr(S.Array(AdditionalRateLimit))),
  rate_limit_reset_credits: S.optional(
    S.NullOr(S.Struct({ available_count: S.Number })),
  ),
})
export type CodexUsage = typeof CodexUsage.Type

export const CodexUsageApi = HttpApi.make('CodexUsage').add(
  HttpApiGroup.make('wham', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/backend-api/wham/usage', { success: CodexUsage }),
  ),
)
