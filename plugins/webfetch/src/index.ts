import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, TruncationResult } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import { formatTruncationNotice, renderExpandableText } from '@pi-plugins/shared'
import { Duration, Effect, Number } from 'effect'
import { Type, type Static } from 'typebox'
import { WebFetch, type WebFetchFormat } from './fetch'

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120

const webFetchSchema = Type.Object({
  url: Type.String({
    description: 'The URL to fetch content from',
  }),
  format: Type.Optional(
    StringEnum(['markdown', 'html'] as const, {
      description: "The format to return the content in ('markdown' or 'html').",
      default: 'markdown',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: 'Timeout in seconds.',
      default: DEFAULT_TIMEOUT_SECONDS,
      minimum: 1,
      maximum: MAX_TIMEOUT_SECONDS,
    }),
  ),
})

export type WebFetchInput = Static<typeof webFetchSchema>

interface WebFetchDetails {
  truncation: TruncationResult
}

export default function webFetch(pi: ExtensionAPI) {
  pi.registerTool<typeof webFetchSchema, WebFetchDetails>({
    name: 'web_fetch',
    label: 'WebFetch',
    description:
      'Fetch an HTTP(S) page and return its content as Markdown (default) or the raw HTML.',
    promptSnippet: 'Fetch HTTP(S) pages as Markdown or raw HTML.',
    parameters: webFetchSchema,
    async execute(_toolCallId, params, signal) {
      const format: WebFetchFormat = params.format ?? 'markdown'
      const timeoutSeconds = Number.clamp(
        params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
        { minimum: 1, maximum: MAX_TIMEOUT_SECONDS },
      )

      const program = Effect.gen(function* () {
        const webfetch = yield* WebFetch
        return yield* webfetch.fetch({
          url: params.url,
          format,
          timeout: Duration.seconds(timeoutSeconds),
        })
      }).pipe(Effect.provide(WebFetch.layer))

      const content = await Effect.runPromise(program, { signal })
      const truncation = truncateHead(content)

      return {
        content: [
          {
            type: 'text' as const,
            text: truncation.truncated
              ? `${truncation.content}\n\n${formatTruncationNotice(truncation)}`
              : truncation.content,
          },
        ],
        details: {
          truncation,
        },
      }
    },
    renderResult({ details }, { expanded }, theme, context) {
      const format = context.args.format ?? 'markdown'
      const header = `${theme.fg('success', '✓')} ${theme.fg('accent', context.args.url)} ${theme.fg(
        'muted',
        `(${format})`,
      )}`

      const text = new Text('', 0, 0)
      text.setText(
        renderExpandableText({
          header,
          content: details.truncation.content,
          expanded,
          theme,
          truncation: details.truncation,
        }),
      )
      return text
    },
  })
}
