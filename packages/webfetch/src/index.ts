import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import { FetchHttpClient, HttpClient } from 'effect/unstable/http'
import { Type, type Static } from 'typebox'

const webFetchSchema = Type.Object({
  url: Type.String({
    description: 'HTTP or HTTPS URL to fetch.',
  }),
})

export type WebFetchInput = Static<typeof webFetchSchema>

export default function webFetch(pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_fetch',
    label: 'WebFetch',
    description:
      "Fetch an HTTP(S) page with a GET request using Effect's HTTP client.",
    promptSnippet: 'Fetch HTTP(S) pages and return response text.',
    parameters: webFetchSchema,
    async execute(_toolCallId, params, signal) {
      const url = normalizeHttpUrl(params.url)
      const response = await fetchWithEffect(url, signal)
      const body = truncateHead(response.body)

      return {
        content: [
          {
            type: 'text' as const,
            text: [
              `Fetched ${url}`,
              `Status: ${response.status}`,
              '',
              body.content,
            ].join('\n'),
          },
        ],
        details: {
          url,
          status: response.status,
          truncated: body.truncated,
        },
      }
    },
  })
}

async function fetchWithEffect(
  url: string,
  signal: AbortSignal | undefined,
): Promise<{ readonly status: number; readonly body: string }> {
  const program = HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => ({
          status: response.status,
          body,
        })),
      ),
    ),
    Effect.provide(FetchHttpClient.layer),
  )

  return Effect.runPromise(program, { signal })
}

function normalizeHttpUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (_error) {
    throw new Error(`Invalid URL: ${value}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(
      `web_fetch only supports http: and https: URLs, received ${url.protocol}`,
    )
  }

  return url.toString()
}
