import { AsyncLocalStorage } from 'node:async_hooks'
import { Defuddle } from 'defuddle/node'
import { Context, Effect, Layer, Record, Schema } from 'effect'
import { parseHTML } from 'linkedom'

export class HtmlConverterError extends Schema.TaggedError<HtmlConverterError>()(
  'HtmlConverterError',
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return 'Failed to convert HTML to Markdown'
  }
}

// defuddle logs the errors it recovers from to the console, which writes over pi's TUI.
// Conversions mute the console for their own async context only, and the last one to
// finish restores it.
const muted = new AsyncLocalStorage<true>()
let conversions = 0
let consoleMethods: Pick<Console, 'error' | 'warn' | 'log'>

export class HtmlConverter extends Context.Service<HtmlConverter>()(
  '@pi-plugins/webfetch/HtmlConverter',
  {
    make: Effect.sync(() => {
      const toMarkdown = Effect.fn('HtmlConverter.toMarkdown')(function* (
        html: string,
        url: string,
      ) {
        return yield* Effect.acquireUseRelease(
          Effect.sync(() => {
            if (conversions++ === 0) {
              consoleMethods = {
                error: console.error,
                warn: console.warn,
                log: console.log,
              }
              Object.assign(
                console,
                Record.map(consoleMethods, (method) => (...args: Array<unknown>) => {
                  if (muted.getStore() === undefined) {
                    method.apply(console, args)
                  }
                }),
              )
            }
          }),
          () =>
            Effect.tryPromise({
              try: () =>
                muted.run(true, async () => {
                  const { document } = parseHTML(html)
                  // linkedom builds no document element from a body without markup, such as
                  // an empty page or plain text, and defuddle fails on it.
                  if (document.documentElement === null) {
                    return html
                  }
                  // defuddle reads the page URL from `location`, which linkedom leaves unset.
                  Object.assign(document, { location: { href: url } })
                  const response = await Defuddle(document, url, { markdown: true })
                  return response.content
                }),
              catch: (cause) => new HtmlConverterError({ cause }),
            }),
          () =>
            Effect.sync(() => {
              if (--conversions === 0) {
                Object.assign(console, consoleMethods)
              }
            }),
        )
      })

      return { toMarkdown }
    }),
  },
) {}

export const layer = Layer.effect(HtmlConverter, HtmlConverter.make)
