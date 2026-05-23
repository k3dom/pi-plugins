import { StringEnum } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { Duration, Effect } from 'effect'
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

export default function webFetch(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_fetch',
    label: 'WebFetch',
    description:
      'Fetch an HTTP(S) page and return its content as Markdown (default) or the raw HTML.',
    promptSnippet: 'Fetch HTTP(S) pages as Markdown or raw HTML.',
    parameters: webFetchSchema,
    async execute(_toolCallId, params, signal) {
      const format: WebFetchFormat = params.format ?? 'markdown'
      const timeoutSeconds = Math.min(
        Math.max(params.timeout ?? DEFAULT_TIMEOUT_SECONDS, 1),
        MAX_TIMEOUT_SECONDS,
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
              ? `${body.content}\n\n[Truncated to ${body.outputLines} of ${body.totalLines} lines]`
              : body.content,
          },
        ],
        details: {
          truncated: body.truncated,
        },
      }
    },
  })
}
