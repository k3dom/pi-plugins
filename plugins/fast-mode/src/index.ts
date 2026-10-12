import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import * as ExtensionConfig from '@pi-plugins/shared/config'
import * as Statusline from '@pi-plugins/shared/statusline'
import {
  Array,
  Data,
  Effect,
  Match,
  Option,
  pipe,
  Predicate,
  Record,
  Schema,
  String,
} from 'effect'

const FastModeConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  models: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(
      Effect.succeed([
        'openai/gpt-5.4',
        'openai/gpt-5.5',
        'openai/gpt-5.6-sol',
        'openai/gpt-5.6-terra',
        'openai/gpt-5.6-luna',
        'openai/gpt-6-astra',
        'openai/gpt-6-sol',
        'openai/gpt-6-luna',
        'openai/gpt-6.1-sol',
        'openai-codex/gpt-5.4',
        'openai-codex/gpt-5.5',
        'openai-codex/gpt-5.6-sol',
        'openai-codex/gpt-5.6-terra',
        'openai-codex/gpt-5.6-luna',
        'openai-codex/gpt-6-astra',
        'openai-codex/gpt-6-sol',
        'openai-codex/gpt-6-luna',
        'openai-codex/gpt-6.1-sol',
      ]),
    ),
  ),
  showStatus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

type Applicator = (
  payload: Record<string, unknown>,
  model: NonNullable<ExtensionContext['model']>,
) => Record<string, unknown> | undefined

type Eligibility = Data.TaggedEnum<{
  Eligible: { readonly apply: Applicator }
  Ineligible: { readonly message: string }
}>
const Eligibility = Data.taggedEnum<Eligibility>()

const FAST_APPLICATORS: Record<string, Applicator> = {
  'openai-responses': applyOpenAIPriorityTier,
  'openai-codex-responses': applyOpenAIPriorityTier,
} satisfies Record<'openai-responses' | 'openai-codex-responses', Applicator>

function applyOpenAIPriorityTier(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  return Record.has(payload, 'service_tier')
    ? undefined
    : { ...payload, service_tier: 'priority' }
}

export default function fastMode(pi: ExtensionAPI) {
  let config = Schema.decodeUnknownSync(FastModeConfig)({})
  let enabled = false

  function checkEligibility(model: ExtensionContext['model']): Eligibility {
    if (!model) {
      return Eligibility.Ineligible({ message: 'no model is selected' })
    }

    const key = `${model.provider}/${model.id}`
    if (!Array.contains(config.models, key)) {
      return Eligibility.Ineligible({
        message: `${key} is not in the configured models`,
      })
    }

    return Option.match(Record.get(FAST_APPLICATORS, model.api), {
      onNone: () =>
        Eligibility.Ineligible({
          message: `the ${model.api} API has no fast-mode support`,
        }),
      onSome: (apply) => Eligibility.Eligible({ apply }),
    })
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) {
      return
    }

    const active =
      config.showStatus &&
      enabled &&
      Eligibility.$is('Eligible')(checkEligibility(ctx.model))

    Statusline.setSegment(
      ctx,
      'fast-mode',
      active ? { text: '[fast mode]', align: 'right' } : undefined,
    )
  }

  function notifyState(ctx: ExtensionContext): void {
    const model = ctx.model
    const name = model?.name ?? '(none)'
    const message = !enabled
      ? `Fast mode is off. Current model: ${name}.`
      : Eligibility.$match(checkEligibility(model), {
          Eligible: () => `Fast mode is on for ${name}.`,
          Ineligible: ({ message: reason }) => {
            const models = Array.match(config.models, {
              onEmpty: () => 'none',
              onNonEmpty: Array.join(', '),
            })
            return `Fast mode is on, but inactive: ${reason}. Configured models: ${models}.`
          },
        })

    ctx.ui.notify(message, 'info')
  }

  pi.on('session_start', async (_event, ctx) => {
    config = await ExtensionConfig.load(ctx, FastModeConfig, 'fast-mode', config)
    enabled = pi.getFlag('fast') === true || config.enabled
    updateStatus(ctx)
  })

  pi.on('model_select', (_event, ctx) => {
    updateStatus(ctx)
  })

  pi.on('before_provider_request', (event, ctx) => {
    const model = ctx.model
    if (!enabled || !model) {
      return undefined
    }

    const eligibility = checkEligibility(model)
    if (
      Eligibility.$is('Ineligible')(eligibility) ||
      !Predicate.isObject(event.payload) ||
      event.payload['model'] !== model.id
    ) {
      return undefined
    }

    return eligibility.apply(event.payload, model)
  })

  pi.registerFlag('fast', {
    description: 'Start with fast mode enabled',
    type: 'boolean',
    default: false,
  })

  pi.registerCommand('fast', {
    description:
      'Toggle fast mode (faster, costlier inference) for configured models',
    getArgumentCompletions: (prefix) => {
      const items = pipe(
        ['on', 'off', 'status'],
        Array.filter(String.startsWith(prefix)),
        Array.map((arg) => ({ value: arg, label: arg })),
      )

      return Array.match(items, {
        onNonEmpty: (matched) => [...matched],
        onEmpty: () => null,
      })
    },
    handler: async (args, ctx) => {
      Match.value(pipe(args, String.trim, String.toLowerCase)).pipe(
        Match.whenOr('', 'on', 'off', (cmd) => {
          enabled = cmd === '' ? !enabled : cmd === 'on'
          updateStatus(ctx)
          notifyState(ctx)
        }),
        Match.when('status', () => notifyState(ctx)),
        Match.orElse(() => ctx.ui.notify('Usage: /fast [on|off|status]', 'warning')),
      )
    },
  })
}
