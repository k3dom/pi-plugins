import { Context, Duration, type Effect, Schema } from 'effect'

export class Result extends Schema.Class<Result>('Result')({
  title: Schema.String,
  url: Schema.String,
  content: Schema.String,
  publishedAt: Schema.optional(Schema.DateTimeUtc),
}) {}

export class RequestError extends Schema.TaggedError<RequestError>()(
  'RequestError',
  {
    provider: Schema.String,
    cause: Schema.ErrorInstance(),
  },
) {
  override get message(): string {
    return `${this.provider} search failed: ${this.cause.message}`
  }
}

export class TimeoutError extends Schema.TaggedError<TimeoutError>()(
  'TimeoutError',
  {
    provider: Schema.String,
    timeout: Schema.Duration,
  },
) {
  override get message(): string {
    return `${this.provider} search timed out after ${Duration.format(this.timeout)}`
  }
}

export class WebSearchError extends Schema.TaggedError<WebSearchError>()(
  'WebSearchError',
  { reason: Schema.Union([RequestError, TimeoutError]) },
) {
  override get message(): string {
    return this.reason.message
  }
}

export class WebSearch extends Context.Service<
  WebSearch,
  {
    readonly search: (options: {
      readonly query: string
      readonly maxResults: number
      readonly timeout: Duration.Duration
    }) => Effect.Effect<ReadonlyArray<Result>, WebSearchError>
  }
>()('@pi-plugins/websearch/WebSearch') {}
