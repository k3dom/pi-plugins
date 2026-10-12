import {
  Array,
  Cause,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  pipe,
  Schedule,
  Schema,
  String,
} from 'effect'
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
} from 'effect/unstable/http'
import * as HtmlConverter from './html-converter'

export class WebFetchError extends Schema.TaggedError<WebFetchError>()(
  'WebFetchError',
  { cause: Schema.ErrorInstance() },
) {
  override get message(): string {
    return this.cause.message
  }
}

export class WebFetch extends Context.Service<WebFetch>()(
  '@pi-plugins/webfetch/WebFetch',
  {
    make: Effect.gen(function* () {
      const converter = yield* HtmlConverter.HtmlConverter
      const http = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(
          HttpClientRequest.setHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          }),
        ),
        HttpClient.filterStatusOk,
        HttpClient.retryTransient({
          times: 3,
          schedule: Schedule.jittered(Schedule.exponential('1 second')),
        }),
      )

      const fetch = Effect.fn('WebFetch.fetch')(
        function* (options: {
          readonly url: string
          readonly format: 'markdown' | 'html'
          readonly timeout: Duration.Duration
        }) {
          const response = yield* http.get(options.url, {
            accept: {
              markdown:
                'text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1',
              html: 'text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1',
            }[options.format],
          })
          const raw = yield* response.text
          if (options.format !== 'markdown') {
            return raw
          }

          const isHtml = Option.match(
            Headers.get(response.headers, 'content-type'),
            {
              onNone: () =>
                /^(?:<!doctype html|<html|<\?xml[\s\S]*<html)/i.test(
                  pipe(raw, String.trimStart, String.takeLeft(1024)),
                ),
              onSome: (contentType) =>
                pipe(
                  contentType,
                  String.split(';'),
                  Array.headNonEmpty,
                  String.trim,
                  String.toLowerCase,
                  (mediaType) =>
                    Array.contains(
                      ['text/html', 'application/xhtml+xml'],
                      mediaType,
                    ),
                ),
            },
          )
          return isHtml ? yield* converter.toMarkdown(raw, options.url) : raw
        },
        (effect, options) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: options.timeout,
              orElse: () =>
                new Cause.TimeoutError(
                  `GET ${options.url} timed out after ${Duration.format(options.timeout)}`,
                ),
            }),
            Effect.mapError((cause) => new WebFetchError({ cause })),
          ),
      )

      return { fetch }
    }),
  },
) {}

export const layer = Layer.effect(WebFetch, WebFetch.make).pipe(
  Layer.provide([HtmlConverter.layer, FetchHttpClient.layer]),
)
