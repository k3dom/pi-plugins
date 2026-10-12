import { Array, DateTime, Order, pipe, Schema } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

export const BASE_URL = {
  zai: 'https://api.z.ai',
  'zai-coding-cn': 'https://open.bigmodel.cn',
} as const
export type Provider = keyof typeof BASE_URL

export const QuotaLimit = Schema.Struct({
  type: Schema.optional(Schema.NullOr(Schema.String)),
  /** Total quota of the window, despite the name. */
  usage: Schema.optional(Schema.NullOr(Schema.Number)),
  currentValue: Schema.optional(Schema.NullOr(Schema.Number)),
  percentage: Schema.optional(Schema.NullOr(Schema.Number)),
  nextResetTime: Schema.optional(Schema.NullOr(Schema.DateTimeUtcFromMillis)),
})
export type QuotaLimit = typeof QuotaLimit.Type

export const Usage = Schema.Struct({
  level: Schema.optional(Schema.NullOr(Schema.String)),
  limits: Schema.optional(Schema.NullOr(Schema.Array(QuotaLimit))),
})
export type Usage = typeof Usage.Type

export const UsageApi = HttpApi.make('GlmUsage').add(
  HttpApiGroup.make('monitor', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/api/monitor/usage/quota/limit', {
      success: Schema.Union([
        Schema.Struct({ success: Schema.Literal(true), data: Usage }),
        Schema.Struct({
          success: Schema.Literal(false),
          code: Schema.Number,
          msg: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ]),
    }),
  ),
)

/** Nothing names a window, so like the official dashboard: first reset = 5h, second = weekly. */
export function rateLimits(usage: Usage): QuotaLimit[] {
  return pipe(
    usage.limits ?? [],
    Array.filter(
      (limit) => limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT',
    ),
    Array.sortWith(
      (limit) =>
        limit.nextResetTime == null
          ? Infinity
          : DateTime.toEpochMillis(limit.nextResetTime),
      Order.Number,
    ),
  )
}
