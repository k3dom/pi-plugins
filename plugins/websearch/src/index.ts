import type { ExtensionAPI, TruncationResult } from '@earendil-works/pi-coding-agent'
import { truncateHead } from '@earendil-works/pi-coding-agent'
import * as Run from '@pi-plugins/shared/run'
import * as Ui from '@pi-plugins/shared/ui'
import { Array, DateTime, Duration, Effect, flow, Number } from 'effect'
import { Type, type Static } from 'typebox'
import * as Tavily from './tavily'
import * as WebSearch from './web-search'

const DEFAULT_MAX_RESULTS = 8
const MAX_RESULTS_LIMIT = 20

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

const webSearchOutputSchema = Type.Object({
  results: Type.Array(
    Type.Object({
      title: Type.String(),
      url: Type.String(),
      content: Type.String({ description: 'Short excerpt of the page content' }),
      publishedAt: Type.Optional(Type.String({ description: 'ISO 8601 timestamp' })),
    }),
  ),
})

export type WebSearchOutput = Static<typeof webSearchOutputSchema>

export default function webSearch(pi: ExtensionAPI) {
  pi.registerTool<
    typeof webSearchSchema,
    {
      results: ReadonlyArray<WebSearch.Result>
      truncation: TruncationResult
    }
  >({
    name: 'web_search',
    label: 'WebSearch',
    description:
      'Search the web and return matching pages with their title, URL and a short content excerpt.',
    promptSnippet: 'Search the web.',
    parameters: webSearchSchema,
    outputSchema: webSearchOutputSchema,
    async execute(_toolCallId, params, signal) {
      const maxResults = Number.clamp(params.maxResults ?? DEFAULT_MAX_RESULTS, {
        minimum: 1,
        maximum: MAX_RESULTS_LIMIT,
      })

      const program = Effect.gen(function* () {
        const websearch = yield* WebSearch.WebSearch
        return yield* websearch.search({
          query: params.query,
          maxResults,
          timeout: Duration.seconds(30),
        })
      }).pipe(Effect.provide(Tavily.layer))

      const results = await Run.tool(program, { signal })
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

      const structuredContent: WebSearchOutput = {
        results: Array.map(results, (result) => ({
          title: result.title,
          url: result.url,
          content: result.content,
          ...(result.publishedAt
            ? { publishedAt: DateTime.formatIso(result.publishedAt) }
            : {}),
        })),
      }

      return {
        content: [{ type: 'text' as const, text: Ui.truncatedText(truncation) }],
        details: {
          results,
          truncation,
        },
        structuredContent,
      }
    },
    renderResult({ details }, { expanded }, theme, context) {
      const count = details.results.length
      const header = `${theme.fg('success', '✓')} ${theme.fg('accent', context.args.query)} ${theme.fg(
        'muted',
        `(${count} ${count === 1 ? 'result' : 'results'})`,
      )}`

      return new Ui.ExpandableText({
        header,
        content: details.truncation.content,
        maxLines: 5,
        expanded,
        theme,
        truncation: details.truncation,
      })
    },
  })
}
