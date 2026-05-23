import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { Duration, Effect } from 'effect'
import { Type, type Static } from 'typebox'
import { WebFetch, type WebFetchFormat } from './fetch'

const DEFAULT_TIMEOUT_SECONDS = 30
const MAX_TIMEOUT_SECONDS = 120

const webFetchSchema = Type.Object({
  url: Type.String({
    description: 'HTTP or HTTPS URL to fetch.',
  }),
  format: Type.Optional(
    Type.Union([Type.Literal('markdown'), Type.Literal('html')], {
      description:
        "Return format: 'markdown' (default) extracts the main content and converts it to Markdown; 'html' returns the raw response body.",
      default: 'markdown',
    }),
  ),
  timeout: Type.Optional(
    Type.Number({
      description: `Optional timeout in seconds (max ${MAX_TIMEOUT_SECONDS}).`,
    }),
  ),
})

export type WebFetchInput = Static<typeof webFetchSchema>

export default function webFetch(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_fetch',
    label: 'WebFetch',
    description:
      'Fetch an HTTP(S) page and return its main content as Markdown (default) or the raw HTML.',
    promptSnippet: 'Fetch HTTP(S) pages as Markdown or raw HTML.',
    parameters: webFetchSchema,
    async execute(_toolCallId, params, signal) {
      const format: WebFetchFormat = params.format ?? 'markdown'
      const timeoutSeconds = Math.min(
        params.timeout ?? DEFAULT_TIMEOUT_SECONDS,
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

      const result = await Effect.runPromise(program, { signal })
      const body = truncateHead(result.content, { maxLines: 5 })

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Fetched ${params.url}`,
              `Status: ${result.status}`,
              '',
              body.content,
            ].join('\n'),
          },
        ],
        details: {
          url: params.url,
          status: result.status,
          format,
          contentType: result.contentType,
          truncated: body.truncated,
        },
      }
    },
  })
}
