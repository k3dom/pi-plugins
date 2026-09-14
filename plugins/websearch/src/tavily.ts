import {
  Cause,
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
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from 'effect/unstable/http'
import { SearchResult, WebSearch } from './search'

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

const ErrorResponse = Schema.Struct({
  detail: Schema.Struct({ error: Schema.String }),
})

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

    const search = Effect.fn(
      function* (options: {
        readonly query: string
        readonly maxResults: number
        readonly timeout: Duration.Input
      }) {
        const response = yield* http
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
                Effect.gen(function* () {
                  const body = yield* Effect.mapError(
                    HttpClientResponse.schemaBodyJson(ErrorResponse)(
                      reason.response,
                    ),
                    () => error,
                  )
                  return yield* new HttpClientError.HttpClientError({
                    reason: new HttpClientError.StatusCodeError({
                      request: reason.request,
                      response: reason.response,
                      description: body.detail.error,
                    }),
                  })
                }),
            ),
          )

        const body = yield* HttpClientResponse.schemaBodyJson(SearchResponse)(
          response,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.DecodeError({
                  request: response.request,
                  response,
                  description: 'unexpected response body',
                  cause,
                }),
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
        _.pipe(
          Effect.timeoutOrElse({
            duration: options.timeout,
            orElse: () =>
              new Cause.TimeoutError(
                `Tavily search timed out after ${Duration.format(
                  Duration.fromInputUnsafe(options.timeout),
                )}`,
              ),
          }),
          Effect.withSpan('Tavily.search', {
            attributes: { query: options.query, maxResults: options.maxResults },
          }),
        ),
    )

    return { search } as const
  }),
).pipe(Layer.provide(FetchHttpClient.layer))
