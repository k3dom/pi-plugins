import { Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

/**
 * Model of the ChatGPT backend usage endpoint the Codex CLI uses:
 *
 *   GET https://chatgpt.com/backend-api/wham/usage
 *
 */

export const CHATGPT_BASE_URL = 'https://chatgpt.com'

/** Snapshot of one rate-limit window. */
export const RateLimitWindow = S.Struct({
  /** Integer percentage used, 0-100. */
  used_percent: S.Number,
  /** Window duration in seconds (e.g. 18000 = 5h, 604800 = 1 week). */
  limit_window_seconds: S.optional(S.NullOr(S.Number)),
  /** Seconds until the window resets. */
  reset_after_seconds: S.optional(S.NullOr(S.Number)),
  /** Unix timestamp (seconds) when the window resets. */
  reset_at: S.optional(S.NullOr(S.Number)),
})
export type RateLimitWindow = typeof RateLimitWindow.Type

export const RateLimitDetails = S.Struct({
  allowed: S.optional(S.NullOr(S.Boolean)),
  limit_reached: S.optional(S.NullOr(S.Boolean)),
  /** Short window (currently 5h). */
  primary_window: S.optional(S.NullOr(RateLimitWindow)),
  /** Long window (currently weekly). */
  secondary_window: S.optional(S.NullOr(RateLimitWindow)),
})
export type RateLimitDetails = typeof RateLimitDetails.Type

export const CreditStatus = S.Struct({
  has_credits: S.optional(S.NullOr(S.Boolean)),
  unlimited: S.optional(S.NullOr(S.Boolean)),
  /** Decimal string, e.g. "9.99". */
  balance: S.optional(S.NullOr(S.String)),
})
export type CreditStatus = typeof CreditStatus.Type

export const AdditionalRateLimit = S.Struct({
  limit_name: S.String,
  rate_limit: S.optional(S.NullOr(RateLimitDetails)),
})
export type AdditionalRateLimit = typeof AdditionalRateLimit.Type

export const CodexUsage = S.Struct({
  /** Plan slug, e.g. "plus" | "pro" | "team" | "business" | "enterprise" | ... */
  plan_type: S.optional(S.NullOr(S.String)),
  rate_limit: S.optional(S.NullOr(RateLimitDetails)),
  credits: S.optional(S.NullOr(CreditStatus)),
  additional_rate_limits: S.optional(S.NullOr(S.Array(AdditionalRateLimit))),
  /** Credits that lift a reached rate limit early (e.g. "3 available"). */
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
