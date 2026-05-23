import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI, TruncationResult } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import {
  formatTruncationNotice,
  getTextOutput,
  renderExpandableText,
} from '@pi-plugins/shared'
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
      description:
        "The format to return the content in ('markdown' or 'html'). Default is 'markdown'.",
      default: 'markdown',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Optional timeout in seconds (max ${MAX_TIMEOUT_SECONDS}).`,
      minimum: 1,
      maximum: MAX_TIMEOUT_SECONDS,
    }),
  ),
})

export type WebFetchInput = Static<typeof webFetchSchema>

interface WebFetchDetails {
  url: string
  format: WebFetchFormat
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
      const body = truncateHead(content)

      return {
        content: [
          {
            type: 'text' as const,
            text: body.truncated
              ? `${body.content}\n\n${formatTruncationNotice(body)}`
              : body.content,
          },
        ],
        details: {
          url: params.url,
          format,
          truncation: body,
        },
      }
    },
    renderResult(result, { expanded }, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text('', 0, 0)
      const details = result.details
      const format = context.args.format ?? details?.format ?? 'markdown'
      const url = context.args.url ?? details?.url ?? 'unknown URL'
      const truncation = details?.truncation
      const output = truncation?.content ?? getTextOutput(result)
      const header = `${theme.fg('success', '✓')} ${theme.fg('accent', url)} ${theme.fg(
        'muted',
        `(${format})`,
      )}`

      text.setText(
        renderExpandableText({
          header,
          content: output,
          expanded,
          theme,
          truncation,
        }),
      )
      return text
    },
  })
}
