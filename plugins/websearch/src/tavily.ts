import {
  Array,
  Config,
  DateTime,
  type Duration,
  Effect,
  flow,
  Layer,
  Option,
  pipe,
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
import * as WebSearch from './web-search'

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

class TavilyError extends Schema.Error<TavilyError>(
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
  WebSearch.WebSearch,
  Effect.gen(function* () {
    const apiKey = yield* Config.option(Config.Redacted('TAVILY_API_KEY'))
    const http = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(
        flow(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader('X-Client-Name', '@pi-plugins/websearch'),
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
        readonly timeout: Duration.Duration
      }) {
        const body = yield* http
          .post('https://api.tavily.com/search', {
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
                new WebSearch.WebSearchError({
                  reason: new WebSearch.RequestError({ provider: 'Tavily', cause }),
                }),
            ),
          )

        return Array.map(
          body.results,
          (result) =>
            new WebSearch.Result({
              title: result.title,
              url: result.url,
              content: result.content,
              publishedAt: pipe(
                result.published_date,
                Option.fromNullishOr,
                Option.flatMap(DateTime.make),
                Option.getOrUndefined,
              ),
            }),
        )
      },
      (effect, options) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              new WebSearch.WebSearchError({
                reason: new WebSearch.TimeoutError({
                  provider: 'Tavily',
                  timeout: options.timeout,
                }),
              }),
          }),
        ),
    )

    return { search }
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
