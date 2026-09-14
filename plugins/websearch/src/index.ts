import type { ExtensionAPI, TruncationResult } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import { runTool } from '@pi-plugins/shared/run'
import { ExpandableText, formatTruncationNotice } from '@pi-plugins/shared/ui'
import { Array, DateTime, Duration, Effect, flow, Number } from 'effect'
import { Type, type Static } from 'typebox'
import { type SearchResult, WebSearch } from './search'
import * as Tavily from './tavily'

const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS_LIMIT = 20
const TIMEOUT = Duration.seconds(30)
const PREVIEW_LINES = 5

const webSearchSchema = Type.Object({
  query: Type.String({
    description: 'The search query.',
  }),
  maxResults: Type.Optional(
    Type.Integer({
      description: 'Maximum number of results to return.',
      default: DEFAULT_MAX_RESULTS,
      minimum: 1,
      maximum: MAX_RESULTS_LIMIT,
    }),
  ),
})

export type WebSearchInput = Static<typeof webSearchSchema>

interface WebSearchDetails {
  results: ReadonlyArray<SearchResult>
  truncation: TruncationResult
}

export default function webSearch(pi: ExtensionAPI) {
  pi.registerTool<typeof webSearchSchema, WebSearchDetails>({
    name: 'web_search',
    label: 'WebSearch',
    description:
      'Search the web and return matching pages with their title, URL and a short content excerpt.',
    promptSnippet: 'Search the web.',
    parameters: webSearchSchema,
    async execute(_toolCallId, params, signal) {
      const maxResults = Number.clamp(params.maxResults ?? DEFAULT_MAX_RESULTS, {
        minimum: 1,
        maximum: MAX_RESULTS_LIMIT,
      })

      const program = Effect.gen(function* () {
        const websearch = yield* WebSearch
        return yield* websearch.search({
          query: params.query,
          maxResults,
          timeout: TIMEOUT,
        })
      }).pipe(Effect.provide(Tavily.layer))

      const results = await runTool(program, { signal })
      const truncation = truncateHead(
        Array.match(results, {
          onEmpty: () => `No results found for "${params.query}".`,
          onNonEmpty: flow(
            Array.map((result) => {
              const published = result.publishedAt
                ? `\nPublished: ${DateTime.formatIsoDateUtc(result.publishedAt)}`
                : ''
              return `## [${result.title}](${result.url})${published}\n\n${result.content}`
            }),
            Array.join('\n\n'),
          ),
        }),
      )

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
          results,
          truncation,
        },
      }
    },
    renderResult({ details }, { expanded }, theme, context) {
      const count = details.results.length
      const header = `${theme.fg('success', '✓')} ${theme.fg('accent', context.args.query)} ${theme.fg(
        'muted',
        `(${count} ${count === 1 ? 'result' : 'results'})`,
      )}`

      return new ExpandableText({
        header,
        content: details.truncation.content,
        maxLines: PREVIEW_LINES,
        expanded,
        theme,
        truncation: details.truncation,
      })
    },
  })
}
