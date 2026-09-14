import { type Cause, Context, type Duration, Effect, Layer, Schema } from 'effect'
import type { HttpClientError } from 'effect/unstable/http'

export class SearchResult extends Schema.Class<SearchResult>('SearchResult')({
  title: Schema.String,
  url: Schema.String,
  content: Schema.String,
  publishedAt: Schema.optionalKey(Schema.DateTimeUtc),
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
) {
  // Placeholder until the first provider layer (Tavily) lands.
  static readonly layer: Layer.Layer<WebSearch> = Layer.succeed(this, {
    search: () => Effect.die('No web search provider is configured.'),
  })
}
