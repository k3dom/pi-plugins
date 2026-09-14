import { Context, type Duration, type Effect, Schema } from 'effect'

export class SearchResult extends Schema.Class<SearchResult>('SearchResult')({
  title: Schema.String,
  url: Schema.String,
  content: Schema.String,
  publishedAt: Schema.optional(Schema.DateTimeUtc),
}) {}

export class WebSearchError extends Schema.TaggedError<WebSearchError>()(
  '@pi-plugins/websearch/WebSearchError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

interface WebSearchService {
  search: (options: {
    readonly query: string
    readonly maxResults: number
    readonly timeout: Duration.Input
  }) => Effect.Effect<ReadonlyArray<SearchResult>, WebSearchError>
}

export class WebSearch extends Context.Service<WebSearch, WebSearchService>()(
  '@pi-plugins/websearch/WebSearch',
) {}
