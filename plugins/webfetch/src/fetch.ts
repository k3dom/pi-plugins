import { Context, Duration, Effect, Layer, Schedule, Schema } from 'effect'
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
} from 'effect/unstable/http'
import { HtmlConverter, HtmlConverterError } from './converter'

export type WebFetchFormat = 'markdown' | 'html'

export class WebFetchTimeoutError extends Schema.TaggedErrorClass<WebFetchTimeoutError>()(
  '@pi-plugins/webfetch/WebFetchTimeoutError',
  {
    message: Schema.String,
  },
) {}

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

interface WebFetchService {
  fetch: (options: {
    url: string
    format: WebFetchFormat
    timeout: Duration.Input
  }) => Effect.Effect<
    string,
    HtmlConverterError | HttpClientError.HttpClientError | WebFetchTimeoutError
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
          const raw = yield* response.text
          if (options.format !== 'markdown') {
            return raw
          }

          const contentType = response.headers['content-type']
          const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
          const isHtml =
            contentType === undefined
              ? /^(?:<!doctype html|<html|<\?xml[\s\S]*<html)/i.test(
                  raw.trimStart().slice(0, 1024),
                )
              : mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
          return isHtml ? yield* converter.toMarkdown(raw, options.url) : raw
        },
        (_, options) =>
          _.pipe(
            Effect.timeoutOrElse({
              duration: options.timeout,
              orElse: () =>
                new WebFetchTimeoutError({
                  message: `GET ${options.url} timed out after ${Duration.format(
                    Duration.fromInputUnsafe(options.timeout),
                  )}`,
                }),
            }),
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
