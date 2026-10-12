import { Defuddle } from 'defuddle/node'
import { Context, Effect, Layer, Schema } from 'effect'
import { parseHTML } from 'linkedom'

export class HtmlConverterError extends Schema.TaggedError<HtmlConverterError>()(
  'HtmlConverterError',
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return 'Failed to convert HTML to Markdown'
  }
}

export class HtmlConverter extends Context.Service<HtmlConverter>()(
  '@pi-plugins/webfetch/HtmlConverter',
  {
    make: Effect.sync(() => {
      const toMarkdown = Effect.fn('HtmlConverter.toMarkdown')(function* (
        html: string,
        url: string,
      ) {
        const response = yield* Effect.tryPromise({
          try: () => {
            const { document } = parseHTML(html)
            // defuddle reads the page URL from `location`, which linkedom leaves unset.
            Object.assign(document, { location: { href: url } })
            return Defuddle(document, url, { markdown: true })
          },
          catch: (cause) => new HtmlConverterError({ cause }),
        })
        return response.content
      })

      return { toMarkdown }
    }),
  },
) {}

export const layer = Layer.effect(HtmlConverter, HtmlConverter.make)
