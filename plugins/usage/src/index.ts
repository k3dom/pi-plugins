import {
  type ExtensionAPI,
  type ExtensionContext,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'
import { Text } from '@earendil-works/pi-tui'
import * as ExtensionConfig from '@pi-plugins/shared/config'
import * as Run from '@pi-plugins/shared/run'
import * as Statusline from '@pi-plugins/shared/statusline'
import { Array, DateTime, Effect, Match, Option, pipe, Record, Schema } from 'effect'
import * as Zai from './provider/zai'
import * as Report from './report'
import * as UsageService from './usage-service'
import * as Widget from './widget'

const EXTENSION_ID = 'usage'
const REPORT_ENTRY_TYPE = 'usage-report'

const UsageConfig = Schema.Struct({
  showWidget: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

type WidgetProvider = 'claude' | 'claude-code' | 'codex' | Zai.Provider

function widgetProvider(
  model: ExtensionContext['model'],
): Option.Option<WidgetProvider> {
  return Match.value(model?.provider).pipe(
    Match.when('anthropic', (): WidgetProvider => 'claude'),
    Match.when('claude-cli', (): WidgetProvider => 'claude-code'),
    Match.when('openai-codex', (): WidgetProvider => 'codex'),
    Match.whenOr('zai', 'zai-coding-cn', (provider) => provider),
    Match.option,
  )
}

function section<A>(
  title: string,
  fetch: Effect.Effect<A, UsageService.UsageServiceError>,
  toSection: (usage: A) => Report.Section,
): Effect.Effect<Report.Section> {
  return fetch.pipe(
    Effect.map(toSection),
    Effect.catchTag('UsageServiceError', (error) =>
      Effect.succeed({ title, error: error.message }),
    ),
  )
}

export default function usage(pi: ExtensionAPI): void {
  let config = Schema.decodeUnknownSync(UsageConfig)({})
  const limitsCache = new Map<WidgetProvider, readonly Widget.Limit[]>()
  const fetchedAt = new Map<WidgetProvider, DateTime.Utc>()
  const inFlight = new Set<WidgetProvider>()

  const recordLimits = Effect.fnUntraced(function* (
    provider: WidgetProvider,
    limits: readonly Widget.Limit[],
  ) {
    limitsCache.set(provider, limits)
    fetchedAt.set(provider, yield* DateTime.now)
  })

  function renderWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return
    }
    const segment = pipe(
      widgetProvider(ctx.model),
      Option.filter(() => config.showWidget),
      Option.flatMapNullishOr((provider) => limitsCache.get(provider)),
      Option.filter(Array.isReadonlyArrayNonEmpty),
      Option.map((limits): Statusline.Segment => ({
        text: Widget.text(limits, DateTime.nowUnsafe()),
        align: 'right',
      })),
    )
    Statusline.setSegment(ctx, EXTENSION_ID, Option.getOrUndefined(segment))
  }

  async function refreshWidget(ctx: ExtensionContext): Promise<void> {
    renderWidget(ctx)
    if (!ctx.hasUI || !config.showWidget) {
      return
    }

    const provider = Option.getOrUndefined(widgetProvider(ctx.model))
    if (provider === undefined || inFlight.has(provider)) {
      return
    }
    const last = fetchedAt.get(provider)
    if (
      last !== undefined &&
      DateTime.isLessThan(
        DateTime.nowUnsafe(),
        DateTime.addDuration(last, '30 seconds'),
      )
    ) {
      return
    }

    inFlight.add(provider)
    const program = Effect.gen(function* () {
      const service = yield* UsageService.UsageService
      switch (provider) {
        case 'claude':
          return Widget.claudeLimits((yield* service.claude()).usage)
        case 'claude-code':
          return Widget.claudeLimits((yield* service.claudeCode()).usage)
        case 'codex':
          return Widget.codexLimits(yield* service.codex(), yield* DateTime.now)
        default:
          return Widget.glmLimits(yield* service.glm(provider))
      }
    }).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)))

    let limits: Widget.Limit[] | undefined
    try {
      limits = await Run.handler(program)
    } finally {
      inFlight.delete(provider)
      // Stamped on failure too, so a broken provider (e.g. not logged in) is not
      // re-queried on every event.
      fetchedAt.set(provider, DateTime.nowUnsafe())
    }
    if (limits !== undefined) {
      limitsCache.set(provider, limits)
      renderWidget(ctx)
    }
  }

  pi.on('session_start', async (_event, ctx) => {
    config = await ExtensionConfig.load(ctx, UsageConfig, EXTENSION_ID, config)
    await refreshWidget(ctx)
  })

  pi.on('model_select', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  // Past retries, auto-compaction and queued follow-ups, unlike agent_end.
  pi.on('agent_settled', async (_event, ctx) => {
    await refreshWidget(ctx)
  })

  pi.registerEntryRenderer(REPORT_ENTRY_TYPE, (entry, _options, theme) =>
    pipe(
      Schema.decodeUnknownOption(Report.Report)(entry.data),
      Option.map((report) => new Text(Report.render(report, theme), 1, 0)),
      Option.getOrUndefined,
    ),
  )

  pi.registerCommand('usage', {
    description: 'Show subscription plan usage and rate limits',
    handler: async (_args, ctx) => {
      const glmProvider = pipe(
        Record.keys(Zai.BASE_URL),
        Array.findFirst(
          (id) => ctx.modelRegistry.getProviderAuthStatus(id).configured,
        ),
        Option.getOrElse((): Zai.Provider => 'zai'),
      )
      // Requests of the claude-cli provider are billed to Claude Code's login,
      // so pi's own Anthropic login only matters once it is set up.
      const claudeCliRegistered = Array.contains(
        ctx.modelRegistry.getRegisteredProviderIds(),
        'claude-cli',
      )
      const showPiClaude =
        !claudeCliRegistered || readStoredCredential('anthropic')?.type === 'oauth'
      const program = Effect.gen(function* () {
        const service = yield* UsageService.UsageService
        const now = yield* DateTime.now
        const sections = yield* Effect.all(
          [
            ...(showPiClaude
              ? [
                  section(
                    'Claude',
                    service
                      .claude()
                      .pipe(
                        Effect.tap((data) =>
                          recordLimits('claude', Widget.claudeLimits(data.usage)),
                        ),
                      ),
                    (data) => Report.claudeSection(data, 'Claude'),
                  ),
                ]
              : []),
            ...(claudeCliRegistered
              ? [
                  section(
                    'Claude Code',
                    service
                      .claudeCode()
                      .pipe(
                        Effect.tap((data) =>
                          recordLimits(
                            'claude-code',
                            Widget.claudeLimits(data.usage),
                          ),
                        ),
                      ),
                    (data) => Report.claudeSection(data, 'Claude Code'),
                  ),
                ]
              : []),
            section(
              'OpenAI Codex',
              service
                .codex()
                .pipe(
                  Effect.tap((data) =>
                    recordLimits('codex', Widget.codexLimits(data, now)),
                  ),
                ),
              (data) => Report.codexSection(data, now),
            ),
            section(
              'GLM Coding',
              service
                .glm(glmProvider)
                .pipe(
                  Effect.tap((data) =>
                    recordLimits(glmProvider, Widget.glmLimits(data)),
                  ),
                ),
              Report.glmSection,
            ),
          ],
          { concurrency: 'unbounded' },
        )
        return yield* Schema.encodeEffect(Report.Report)({
          fetchedAt: now,
          sections,
        }).pipe(Effect.orDie)
      }).pipe(Effect.provide(UsageService.layer(ctx.modelRegistry)))

      const report = await Run.handler(program, {
        onError: (message) => {
          ctx.ui.notify(`Failed to fetch usage: ${message}`, 'error')
          return undefined
        },
      })
      if (report !== undefined) {
        pi.appendEntry(REPORT_ENTRY_TYPE, report)
      }
      renderWidget(ctx)
    },
  })
}
