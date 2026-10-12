import {
  DateTime,
  Duration,
  Option,
  pipe,
  Schema,
  SchemaTransformation,
} from 'effect'
import { HttpApi, HttpApiEndpoint, HttpApiGroup } from 'effect/unstable/httpapi'

export const BASE_URL = 'https://chatgpt.com'

const Seconds = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transform({
      decode: Duration.seconds,
      encode: Duration.toSeconds,
    }),
  ),
)

const EpochSeconds = Schema.Number.pipe(
  Schema.decodeTo(
    Schema.DateTimeUtc,
    SchemaTransformation.transform({
      decode: DateTime.fromEpochSeconds,
      encode: DateTime.toEpochSeconds,
    }),
  ),
)

export const RateLimitWindow = Schema.Struct({
  used_percent: Schema.Number,
  limit_window_seconds: Schema.optional(Schema.NullOr(Seconds)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Seconds)),
  reset_at: Schema.optional(Schema.NullOr(EpochSeconds)),
})
export type RateLimitWindow = typeof RateLimitWindow.Type

export const RateLimitDetails = Schema.Struct({
  allowed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  limit_reached: Schema.optional(Schema.NullOr(Schema.Boolean)),
  primary_window: Schema.optional(Schema.NullOr(RateLimitWindow)),
  secondary_window: Schema.optional(Schema.NullOr(RateLimitWindow)),
})
export type RateLimitDetails = typeof RateLimitDetails.Type

export const Usage = Schema.Struct({
  email: Schema.optional(Schema.NullOr(Schema.String)),
  plan_type: Schema.optional(Schema.NullOr(Schema.String)),
  rate_limit: Schema.optional(Schema.NullOr(RateLimitDetails)),
  credits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        has_credits: Schema.optional(Schema.NullOr(Schema.Boolean)),
        unlimited: Schema.optional(Schema.NullOr(Schema.Boolean)),
        balance: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
  additional_rate_limits: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          limit_name: Schema.String,
          rate_limit: Schema.optional(Schema.NullOr(RateLimitDetails)),
        }),
      ),
    ),
  ),
  rate_limit_reset_credits: Schema.optional(
    Schema.NullOr(Schema.Struct({ available_count: Schema.Number })),
  ),
})
export type Usage = typeof Usage.Type

export const UsageApi = HttpApi.make('CodexUsage').add(
  HttpApiGroup.make('wham', { topLevel: true }).add(
    HttpApiEndpoint.get('usage', '/backend-api/wham/usage', { success: Usage }),
  ),
)

export function windowName(
  window: RateLimitWindow,
  names: { readonly unknown: string; readonly week: string },
): string {
  const length = window.limit_window_seconds
  if (length == null || !Duration.isPositive(length)) {
    return names.unknown
  }
  if (Duration.isGreaterThanOrEqualTo(length, Duration.weeks(0.9))) {
    return names.week
  }
  if (Duration.isGreaterThanOrEqualTo(length, Duration.days(1))) {
    return `${Math.round(Duration.toDays(length))}d`
  }
  return `${Math.round(Duration.toHours(length))}h`
}

export function resetsAt(
  window: RateLimitWindow,
  now: DateTime.Utc,
): Option.Option<DateTime.Utc> {
  return pipe(
    Option.fromNullishOr(window.reset_after_seconds),
    Option.map((after) => DateTime.addDuration(now, after)),
    Option.orElse(() => Option.fromNullishOr(window.reset_at)),
  )
}
