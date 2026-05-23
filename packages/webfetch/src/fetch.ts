import { Context, Duration, Effect, Layer, Schedule } from 'effect'
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

function shouldConvertToMarkdown(
  contentType: string | undefined,
  content: string,
): boolean {
  if (contentType !== undefined) {
    const mediaType = contentType.split(';', 1)[0]?.trim().toLowerCase()
    return mediaType === 'text/html' || mediaType === 'application/xhtml+xml'
  }
  const prefix = content.trimStart().slice(0, 1024)
  return /^(?:<!doctype html|<html|<\?xml[\s\S]*<html)/i.test(prefix)
}

interface WebFetchService {
  fetch: (options: {
    url: string
    format: WebFetchFormat
    timeout: Duration.Input
  }) => Effect.Effect<
    string,
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
          const contentType = response.headers['content-type']
          const raw = yield* response.text

          if (
            options.format === 'markdown' &&
            shouldConvertToMarkdown(contentType, raw)
          ) {
            return yield* converter.toMarkdown(raw, options.url)
          }

          return raw
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
