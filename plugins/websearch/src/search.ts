import { type Cause, Context, type Duration, type Effect, Schema } from 'effect'
import type { HttpClientError } from 'effect/unstable/http'

export class SearchResult extends Schema.Class<SearchResult>('SearchResult')({
  title: Schema.String,
  url: Schema.String,
  content: Schema.String,
  publishedAt: Schema.optional(Schema.DateTimeUtc),
}) {}

interface WebSearchService {
  search: (options: {
    readonly query: string
    readonly maxResults: number
    readonly timeout: Duration.Input
  }) => Effect.Effect<
    ReadonlyArray<SearchResult>,
    HttpClientError.HttpClientError | Cause.TimeoutError
  >
}

export class WebSearch extends Context.Service<WebSearch, WebSearchService>()(
  '@pi-plugins/websearch/WebSearch',
) {}
