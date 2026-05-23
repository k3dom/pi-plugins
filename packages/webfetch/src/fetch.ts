import { Context, Duration, Effect, Layer, Option, Schedule } from 'effect'
import type { TimeoutError } from 'effect/Cause'
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
} from 'effect/unstable/http'
import { HtmlConverter, HtmlConverterError } from './converter'

export type WebFetchFormat = 'markdown' | 'html'

const ACCEPT_HEADERS: Record<WebFetchFormat, string> = {
  markdown:
    'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
  html: 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1',
}

const BROWSER_HEADERS = {
  'Accept-Language': 'en-US,en;q=0.9',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
}

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
        HttpClient.retryTransient({
          times: 3,
          schedule: Schedule.jittered(Schedule.exponential('1 second')),
        }),
      )

      const fetch = Effect.fn(
        function* (options: {
          url: string
          format: WebFetchFormat
          timeout: Duration.Input
        }) {
          const response = yield* http.get(options.url, {
            headers: {
              Accept: ACCEPT_HEADERS[options.format],
            },
          })
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
        (_, options) =>
          _.pipe(
            Effect.timeout(options.timeout),
            Effect.withSpan('WebFetch.fetch', {
              attributes: { url: options.url, format: options.format },
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
