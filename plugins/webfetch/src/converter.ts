import { Defuddle } from 'defuddle/node'
import { Context, Effect, Layer, Schema } from 'effect'
import { parseHTML } from 'linkedom'

export class HtmlConverterError extends Schema.TaggedErrorClass<HtmlConverterError>()(
  '@pi-plugins/webfetch/HtmlConverterError',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface HtmlConverterService {
  toMarkdown: (
    html: string,
    url: string,
  ) => Effect.Effect<string, HtmlConverterError>
}

export class HtmlConverter extends Context.Service<
  HtmlConverter,
  HtmlConverterService
>()('@pi-plugins/webfetch/HtmlConverter', {
  make: Effect.succeed({
    toMarkdown: Effect.fn(
      function* (html: string, url: string) {
        const response = yield* Effect.tryPromise({
          try: () => {
            const { document } = parseHTML(html)
            // defuddle reads the page URL from `location`, which linkedom leaves unset.
            Object.assign(document, { location: { href: url } })
            return Defuddle(document, url, { markdown: true })
          },
          catch: (cause) =>
            new HtmlConverterError({
              message: 'Failed to convert HTML to Markdown',
              cause,
            }),
        })
        return response.content
      },
      Effect.withSpan('HtmlConverter.toMarkdown', (_, url) => ({
        attributes: {
          url: url,
        },
      })),
    ),
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
