import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Cause, Effect, Exit } from 'effect'
import {
  claudeSection,
  codexSection,
  renderSections,
  type UsageSection,
} from './render'
import { UsageService, type UsageServiceError } from './service'

/**
 * Turns a provider fetch into a report section, mapping failures to an
 * inline message so one provider failing never hides the other.
 */
function section<A>(
  title: string,
  fetch: Effect.Effect<A, UsageServiceError>,
  toSection: (usage: A) => UsageSection,
): Effect.Effect<UsageSection> {
  return fetch.pipe(
    Effect.map(toSection),
    Effect.catch((error) => Effect.succeed({ title, error: error.message })),
  )
}

export default function usage(pi: ExtensionAPI): void {
  pi.registerCommand('usage', {
    description:
      'Show subscription usage/rate limits for Claude and OpenAI Codex plans',
    handler: async (_args, ctx) => {
      const now = new Date()
      const program = Effect.gen(function* () {
        const service = yield* UsageService
        const sections = yield* Effect.all(
          [
            section('Claude', service.claude(), claudeSection),
            section('OpenAI Codex', service.codex(), (data) =>
              codexSection(data, now),
            ),
          ],
          { concurrency: 'unbounded' },
        )
        // One message per provider so each carries its own severity:
        // successful sections stay informational, failures become warnings.
        const rendered = renderSections(sections, now)
        return sections.map((usageSection, index) => ({
          report: rendered[index] ?? '',
          severity:
            'error' in usageSection ? ('warning' as const) : ('info' as const),
        }))
      }).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)))

      const exit = await Effect.runPromiseExit(program)
      Exit.match(exit, {
        onSuccess: (messages) => {
          for (const { report, severity } of messages) {
            ctx.ui.notify(report, severity)
          }
        },
        onFailure: (cause) =>
          ctx.ui.notify(`Failed to fetch usage: ${Cause.pretty(cause)}`, 'error'),
      })
    },
  })
}
