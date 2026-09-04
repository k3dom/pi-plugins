import { Array, Order, pipe, Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

export const ZAI_BASE_URL = {
  zai: 'https://api.z.ai',
  'zai-coding-cn': 'https://open.bigmodel.cn',
} as const
export type ZaiProvider = keyof typeof ZAI_BASE_URL

export const QuotaLimit = S.Struct({
  type: S.optional(S.NullOr(S.String)),
  /** Total quota of the window, despite the name. */
  usage: S.optional(S.NullOr(S.Number)),
  currentValue: S.optional(S.NullOr(S.Number)),
  percentage: S.optional(S.NullOr(S.Number)),
  nextResetTime: S.optional(S.NullOr(S.DateFromMillis)),
})
export type QuotaLimit = typeof QuotaLimit.Type

export const GlmUsage = S.Struct({
  level: S.optional(S.NullOr(S.String)),
  limits: S.optional(S.NullOr(S.Array(QuotaLimit))),
})
export type GlmUsage = typeof GlmUsage.Type

export const GlmUsageEnvelope = S.Union([
  S.Struct({ success: S.Literal(true), data: GlmUsage }),
  S.Struct({
    success: S.Literal(false),
    code: S.Number,
    msg: S.optional(S.NullOr(S.String)),
  }),
])
export type GlmUsageEnvelope = typeof GlmUsageEnvelope.Type

export const GlmUsageApi = HttpApi.make('GlmUsage').add(
  HttpApiGroup.make('monitor', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/api/monitor/usage/quota/limit', {
      success: GlmUsageEnvelope,
    }),
  ),
)

/** Nothing names a window, so like the official dashboard: first reset = 5h, second = weekly. */
export function glmRateLimits(usage: GlmUsage): QuotaLimit[] {
  return pipe(
    usage.limits ?? [],
    Array.filter(
      (limit) => limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT',
    ),
    Array.sortWith(
      (limit) => limit.nextResetTime?.getTime() ?? Number.POSITIVE_INFINITY,
      Order.Number,
    ),
  )
}
