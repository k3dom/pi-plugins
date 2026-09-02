import { Schema as S } from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

/**
 * Model of the GLM Coding Plan usage endpoint (Z.ai global / Zhipu China).
 * Undocumented console API the official usage dashboard calls:
 *
 *   GET https://api.z.ai/api/monitor/usage/quota/limit
 *   GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *
 */

export const ZAI_BASE_URL = 'https://api.z.ai'
export const ZAI_CN_BASE_URL = 'https://open.bigmodel.cn'

/**
 * One quota window. `type` depends on plan generation: `TOKENS_LIMIT` (token
 * plans), `CREDIT_LIMIT` (points plans), `TIME_LIMIT` (monthly MCP tools).
 */
export const ZaiQuotaLimit = S.Struct({
  /** "TOKENS_LIMIT" | "CREDIT_LIMIT" | "TIME_LIMIT" | future values. */
  type: S.optional(S.NullOr(S.String)),
  /**
   * Window duration as unit enum + count: unit 3 (hour) + 5 → 5h window,
   * unit 6 (week) + 1 → weekly window. Values are inferred, not documented.
   */
  unit: S.optional(S.NullOr(S.Number)),
  number: S.optional(S.NullOr(S.Number)),
  /** Total quota of the window (tokens or credits). */
  usage: S.optional(S.NullOr(S.Number)),
  /** Amount used in the current window. */
  currentValue: S.optional(S.NullOr(S.Number)),
  remaining: S.optional(S.NullOr(S.Number)),
  /** Percentage used, 0-100. */
  percentage: S.optional(S.NullOr(S.Number)),
  /** Epoch milliseconds when the window resets. */
  nextResetTime: S.optional(S.NullOr(S.Number)),
})
export type ZaiQuotaLimit = typeof ZaiQuotaLimit.Type

export const ZaiUsageData = S.Struct({
  limits: S.optional(S.NullOr(S.Array(ZaiQuotaLimit))),
  /** Plan tier, e.g. "lite" | "pro" | "max". */
  level: S.optional(S.NullOr(S.String)),
})
export type ZaiUsageData = typeof ZaiUsageData.Type

/**
 * Every endpoint of the platform returns this envelope with HTTP 200; API
 * errors are `success: false` / `code !== 200` inside the body.
 */
export const ZaiUsageEnvelope = S.Struct({
  code: S.optional(S.NullOr(S.Number)),
  msg: S.optional(S.NullOr(S.String)),
  data: S.optional(S.NullOr(ZaiUsageData)),
  success: S.optional(S.NullOr(S.Boolean)),
})
export type ZaiUsageEnvelope = typeof ZaiUsageEnvelope.Type

export const ZaiUsageApi = HttpApi.make('ZaiUsage').add(
  HttpApiGroup.make('monitor', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/api/monitor/usage/quota/limit', {
      success: ZaiUsageEnvelope,
    }),
  ),
)

/**
 * Rate-limit windows of the plan (token/credit limits only; the monthly MCP
 * `TIME_LIMIT` is separate), sorted by `nextResetTime`. The official
 * dashboard treats the first entry as the 5h window and the second as the
 * weekly one, since `unit`/`number` are undocumented.
 */
export function zaiRateLimits(usage: ZaiUsageData): ZaiQuotaLimit[] {
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

/** Monthly MCP tools quota (`TIME_LIMIT`), if the plan reports one. */
export function zaiMcpLimit(usage: ZaiUsageData): ZaiQuotaLimit | undefined {
  return (usage.limits ?? []).find((limit) => limit.type === 'TIME_LIMIT')
}

/** Unit word for the quota counters, by plan generation. */
export function zaiUnitWord(limit: ZaiQuotaLimit): string {
  switch (limit.type) {
    case 'CREDIT_LIMIT':
      return 'credits'
    case 'TIME_LIMIT':
      return 'uses'
    default:
      return 'tokens'
  }
}
