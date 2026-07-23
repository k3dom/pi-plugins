import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { loadExtensionConfig, setStatuslineSegment } from '@pi-plugins/shared'
import { Cause, Effect, Exit, Schema } from 'effect'
import {
  claudeSection,
  codexSection,
  renderSections,
  type UsageSection,
} from './render'
import { UsageService, type UsageServiceError } from './service'
import {
  claudeWidgetLimits,
  codexWidgetLimits,
  widgetText,
  type WidgetLimit,
} from './widget'

const EXTENSION_ID = 'usage'
/** Status-line segment shown above the editor with compact rate-limit bars. */
const SEGMENT_KEY = EXTENSION_ID
/** Minimum time between two background usage fetches for the widget. */
const WIDGET_REFRESH_MS = 30_000

const UsageConfig = Schema.Struct({
  /** Show rate-limit bars above the editor for the active model's provider. */
  showWidget: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

/** Subscription the widget reports on, derived from the active model. */
type WidgetProvider = 'claude' | 'codex'

function widgetProvider(
  model: ExtensionContext['model'],
): WidgetProvider | undefined {
  switch (model?.provider) {
    case 'anthropic':
      return 'claude'
    case 'openai-codex':
      return 'codex'
    default:
      return undefined
  }
}

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
  let config = Schema.decodeUnknownSync(UsageConfig)({})
  /** Latest widget limits per provider; kept across model switches. */
  const limitsCache = new Map<WidgetProvider, readonly WidgetLimit[]>()
  const fetchedAt = new Map<WidgetProvider, number>()
  const inFlight = new Set<WidgetProvider>()

  function recordLimits(
    provider: WidgetProvider,
    limits: readonly WidgetLimit[],
  ): void {
    limitsCache.set(provider, limits)
    fetchedAt.set(provider, Date.now())
  }

  /** Redraws the segment from cache for the active model's provider. */
  function renderWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return
    }
    const provider = config.showWidget ? widgetProvider(ctx.model) : undefined
    const text =
      provider === undefined ? undefined : widgetText(limitsCache.get(provider))
    setStatuslineSegment(
      ctx,
      SEGMENT_KEY,
      text === undefined ? undefined : { text, align: 'right' },
    )
  }

  /** Redraws from cache, then refetches in the background when the data is stale. */
  async function refreshWidget(ctx: ExtensionContext): Promise<void> {
    renderWidget(ctx)
    if (!ctx.hasUI || !config.showWidget) {
      return
    }

    const provider = widgetProvider(ctx.model)
    if (provider === undefined || inFlight.has(provider)) {
      return
    }
    const last = fetchedAt.get(provider)
    if (last !== undefined && Date.now() - last < WIDGET_REFRESH_MS) {
      return
    }

    inFlight.add(provider)
    const program = Effect.gen(function* () {
      const service = yield* UsageService
      return provider === 'claude'
        ? claudeWidgetLimits(yield* service.claude())
        : codexWidgetLimits(yield* service.codex())
    }).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)))

    const exit = await Effect.runPromiseExit(program)
    inFlight.delete(provider)
    // Record the attempt time even on failure so a broken provider (e.g. not
    // logged in) is not re-queried on every event.
    fetchedAt.set(provider, Date.now())
    if (Exit.isSuccess(exit)) {
      limitsCache.set(provider, exit.value)
      renderWidget(ctx)
    }
    // On failure keep whatever is shown; /usage reports errors explicitly.
  }

  pi.on('session_start', async (_event, ctx) => {
    config = await Effect.runPromise(
      loadExtensionConfig(UsageConfig, EXTENSION_ID).pipe(
        Effect.orElseSucceed(() => config),
        Effect.provide(NodeServices.layer),
      ),
    )
    await refreshWidget(ctx)
  })

  pi.on('model_select', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  pi.on('agent_end', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  pi.registerCommand('usage', {
    description:
      'Show subscription usage/rate limits for Claude and OpenAI Codex plans',
    handler: async (_args, ctx) => {
      const now = new Date()
      const program = Effect.gen(function* () {
        const service = yield* UsageService
        const sections = yield* Effect.all(
          [
            section(
              'Claude',
              service
                .claude()
                .pipe(
                  Effect.tap((data) =>
                    Effect.sync(() =>
                      recordLimits('claude', claudeWidgetLimits(data)),
                    ),
                  ),
                ),
              claudeSection,
            ),
            section(
              'OpenAI Codex',
              service
                .codex()
                .pipe(
                  Effect.tap((data) =>
                    Effect.sync(() =>
                      recordLimits('codex', codexWidgetLimits(data)),
                    ),
                  ),
                ),
              (data) => codexSection(data, now),
            ),
          ],
          { concurrency: 'unbounded' },
        )
        // The UI only shows one message per severity, so group sections by
        // outcome: all successes in one info message, all failures in one
        // warning message.
        const rendered = renderSections(sections, now)
        const grouped = { info: [] as string[], warning: [] as string[] }
        sections.forEach((usageSection, index) => {
          grouped['error' in usageSection ? 'warning' : 'info'].push(
            rendered[index] ?? '',
          )
        })
        return (['info', 'warning'] as const)
          .filter((severity) => grouped[severity].length > 0)
          .map((severity) => ({
            report: grouped[severity].join('\n\n'),
            severity,
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
      // The command fetched fresh data for both providers — reuse it.
      renderWidget(ctx)
    },
  })
}
