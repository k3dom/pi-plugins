import {
  Config,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Schedule,
  Schema,
} from 'effect'
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/unstable/http'
import { SearchResult, WebSearch, WebSearchError } from './search'

const ENDPOINT = 'https://api.tavily.com/search'

const SearchResponse = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      url: Schema.String,
      content: Schema.String,
      published_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
    }),
  ),
})

class TavilyError extends Schema.ErrorClass<TavilyError>(
  '@pi-plugins/websearch/TavilyError',
)({
  _tag: Schema.tagDefaultOmit('TavilyError'),
  detail: Schema.Struct({ error: Schema.String }),
}) {
  override get message() {
    return this.detail.error
  }
}

export const layer = Layer.effect(
  WebSearch,
  Effect.gen(function* () {
    const apiKey = yield* Config.option(Config.redacted('TAVILY_API_KEY'))
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest((request) =>
        request.pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader('X-Client-Name', 'pi-plugins-websearch'),
          Option.match(apiKey, {
            onNone: () =>
              HttpClientRequest.setHeader('X-Tavily-Access-Mode', 'keyless'),
            onSome: (key) => HttpClientRequest.bearerToken(key),
          }),
        ),
      ),
      HttpClient.retryTransient({
        times: 2,
        schedule: Schedule.jittered(Schedule.exponential('1 second')),
      }),
      HttpClient.filterStatusOk,
    )

    const search = Effect.fn('Tavily.search')(
      function* (options: {
        readonly query: string
        readonly maxResults: number
        readonly timeout: Duration.Input
      }) {
        const body = yield* http
          .post(ENDPOINT, {
            body: HttpBody.jsonUnsafe({
              query: options.query,
              search_depth: 'basic',
              chunks_per_source: 3,
              max_results: options.maxResults,
              include_published_date: true,
            }),
          })
          .pipe(
            Effect.catchReason(
              'HttpClientError',
              'StatusCodeError',
              (reason, error) =>
                HttpClientResponse.schemaBodyJson(TavilyError)(reason.response).pipe(
                  Effect.mapError(() => error),
                  Effect.flatMap(Effect.fail),
                ),
            ),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(SearchResponse)),
            Effect.mapError(
              (cause) =>
                new WebSearchError({
                  message: `Tavily search failed: ${cause.message}`,
                  cause,
                }),
            ),
          )

        return body.results.map(
          (result) =>
            new SearchResult({
              title: result.title,
              url: result.url,
              content: result.content,
              publishedAt: Option.getOrUndefined(
                Option.flatMap(
                  Option.fromNullishOr(result.published_date),
                  DateTime.make,
                ),
              ),
            }),
        )
      },
      (_, options) =>
        Effect.timeoutOrElse(_, {
          duration: options.timeout,
          orElse: () =>
            new WebSearchError({
              message: `Tavily search timed out after ${Duration.format(
                Duration.fromInputUnsafe(options.timeout),
              )}`,
            }),
        }),
    )

    return { search } as const
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
