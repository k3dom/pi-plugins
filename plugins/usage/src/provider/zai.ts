import { Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

/** Console API host of each pi provider (global Z.ai vs. Zhipu China platform). */
export const ZAI_BASE_URL = {
  zai: 'https://api.z.ai',
  'zai-coding-cn': 'https://open.bigmodel.cn',
} as const
export type ZaiProvider = keyof typeof ZAI_BASE_URL

export const QuotaLimit = S.Struct({
  /** `TOKENS_LIMIT` (token plans), `CREDIT_LIMIT` (credit plans) or `TIME_LIMIT` (monthly MCP tools). */
  type: S.optional(S.NullOr(S.String)),
  /** Total quota of the window, despite the name. */
  usage: S.optional(S.NullOr(S.Number)),
  currentValue: S.optional(S.NullOr(S.Number)),
  percentage: S.optional(S.NullOr(S.Number)),
  /** Epoch milliseconds. */
  nextResetTime: S.optional(S.NullOr(S.Number)),
})
export type QuotaLimit = typeof QuotaLimit.Type

export const GlmUsage = S.Struct({
  level: S.optional(S.NullOr(S.String)),
  limits: S.optional(S.NullOr(S.Array(QuotaLimit))),
})
export type GlmUsage = typeof GlmUsage.Type

/** API errors arrive as HTTP 200 with the failure inside this envelope. */
export const GlmUsageEnvelope = S.Struct({
  code: S.optional(S.NullOr(S.Number)),
  msg: S.optional(S.NullOr(S.String)),
  success: S.optional(S.NullOr(S.Boolean)),
  data: S.optional(S.NullOr(GlmUsage)),
})
export type GlmUsageEnvelope = typeof GlmUsageEnvelope.Type

export const GlmUsageApi = HttpApi.make('GlmUsage').add(
  HttpApiGroup.make('monitor', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/api/monitor/usage/quota/limit', {
      success: GlmUsageEnvelope,
    }),
  ),
)

/**
 * The token/credit windows in reset order. Nothing in the payload names a
 * window, so like the official dashboard the first is taken as the 5h window
 * and the second as the weekly one.
 */
export function glmRateLimits(usage: GlmUsage): QuotaLimit[] {
  return (usage.limits ?? [])
    .filter(
      (limit) => limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT',
    )
    .toSorted(
      (a, b) =>
        (a.nextResetTime ?? Number.POSITIVE_INFINITY) -
        (b.nextResetTime ?? Number.POSITIVE_INFINITY),
    )
}
