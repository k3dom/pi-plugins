import { Context, Duration, Effect, Layer, Option } from 'effect'
import type { TimeoutError } from 'effect/Cause'
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
} from 'effect/unstable/http'
import { HtmlConverter, HtmlConverterError } from './converter'

const BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
}

export type WebFetchFormat = 'markdown' | 'html'

export interface WebFetchResult {
  content: string
  contentType: Option.Option<string>
  status: number
}

interface WebFetchService {
  fetch: (options: {
    url: string
    format: WebFetchFormat
    timeout: Duration.Input
  }) => Effect.Effect<
    WebFetchResult,
    HtmlConverterError | HttpClientError.HttpClientError | TimeoutError
  >
}

export class WebFetch extends Context.Service<WebFetch, WebFetchService>()(
  '@pi-plugins/webfetch/WebFetch',
  {
    make: Effect.gen(function* () {
      const converter = yield* HtmlConverter
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          HttpClientRequest.setHeaders(request, BROWSER_HEADERS),
        ),
        HttpClient.filterStatusOk,
      )

      const fetch = Effect.fn(
        function* (options: {
          url: string
          format: WebFetchFormat
          timeout: Duration.Input
        }) {
          const response = yield* http.get(options.url)
          const contentType = Option.fromNullishOr(response.headers['content-type'])
          const raw = yield* response.text

          let content = raw
          if (
            options.format === 'markdown' &&
            Option.isSome(contentType) &&
            contentType.value.includes('text/html')
          ) {
            content = yield* converter.toMarkdown(raw, options.url)
          }

          return {
            content,
            contentType,
            status: response.status,
          }
        },
        (_, params) =>
          _.pipe(
            Effect.timeout(params.timeout),
            Effect.withSpan('WebFetch.fetch', {
              attributes: { url: params.url, format: params.format },
            }),
          ),
      )

      return { fetch } as const
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([HtmlConverter.layer, FetchHttpClient.layer]),
  )
}
