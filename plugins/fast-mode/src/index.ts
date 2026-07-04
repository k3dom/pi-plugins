import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { loadExtensionConfig } from '@pi-plugins/shared'
import { Array, Data, Effect, pipe, Predicate, Record, Schema, String } from 'effect'

const EXTENSION_ID = 'fast-mode'
const COMMAND_ARGS = ['on', 'off', 'status'] as const

const FastModeConfig = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** `provider/model-id` keys that fast mode applies to. */
  models: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(
      Effect.succeed([
        'openai/gpt-5.4',
        'openai/gpt-5.5',
        'openai-codex/gpt-5.4',
        'openai-codex/gpt-5.5',
      ]),
    ),
  ),
  /** Show a `fast` indicator in the status line while active. */
  showStatus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})
type FastModeConfig = typeof FastModeConfig.Type

/** Rewrites a provider request payload to ask for fast inference. */
type Applicator = (payload: Record<string, unknown>) => Record<string, unknown>

/** Whether fast mode can apply to the active model. */
type Eligibility = Data.TaggedEnum<{
  Eligible: { readonly apply: Applicator }
  Ineligible: { readonly message: string }
}>
const Eligibility = Data.taggedEnum<Eligibility>()

/**
 * How to request fast inference for a given provider API,
 * keyed by the model's `api`.
 */
const FAST_APPLICATORS: Record<string, Applicator> = {
  'openai-responses': applyOpenAIPriorityTier,
  'openai-codex-responses': applyOpenAIPriorityTier,
}

function applyOpenAIPriorityTier(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  // If the request already has a `service_tier`, don't override it.
  return Record.has(payload, 'service_tier')
    ? payload
    : { ...payload, service_tier: 'priority' }
}

export default function fastMode(pi: ExtensionAPI) {
  let config = Schema.decodeUnknownSync(FastModeConfig)({})
  let enabled = false

  function checkEligibility(model: ExtensionContext['model']): Eligibility {
    if (!model) {
      return Eligibility.Ineligible({ message: 'no model is selected' })
    }

    if (!config.models.includes(model.name)) {
      return Eligibility.Ineligible({
        message: `${model.name} is not in the configured models`,
      })
    }

    const apply = FAST_APPLICATORS[model.api]
    if (!apply) {
      return Eligibility.Ineligible({
        message: `the ${model.api} API has no fast-mode support`,
      })
    }

    return Eligibility.Eligible({ apply })
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI && config.showStatus) {
      const eligibility = checkEligibility(ctx.model)
      ctx.ui.setStatus(
        EXTENSION_ID,
        enabled && Eligibility.$is('Eligible')(eligibility) ? 'fast' : undefined,
      )
    }
  }

  function describe(model: ExtensionContext['model']): string {
    const name = model?.name ?? '(none)'
    if (!enabled) {
      return `Fast mode is off. Current model: ${name}.`
    }

    return Eligibility.$match(checkEligibility(model), {
      Eligible: () => `Fast mode is on for ${name}.`,
      Ineligible: ({ message }) => {
        const models = config.models.join(', ') || 'none'
        return `Fast mode is on, but inactive: ${message}. Configured models: ${models}.`
      },
    })
  }

  pi.on('session_start', (_event, ctx) => {
    config = loadExtensionConfig(FastModeConfig, EXTENSION_ID)
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

    const next = eligibility.apply(event.payload)
    return next === event.payload ? undefined : next
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
        COMMAND_ARGS,
        Array.filter(String.startsWith(prefix)),
        Array.map((arg) => ({ value: arg, label: arg })),
      )

      return Array.match(items, {
        onNonEmpty: (matched) => [...matched],
        onEmpty: () => null,
      })
    },
    handler: async (args, ctx) => {
      switch (args.trim().toLowerCase()) {
        case '':
          enabled = !enabled
          break
        case 'on':
          enabled = true
          break
        case 'off':
          enabled = false
          break
        case 'status':
          ctx.ui.notify(describe(ctx.model), 'info')
          return
        default:
          ctx.ui.notify('Usage: /fast [on|off|status]', 'warning')
          return
      }

      updateStatus(ctx)
      ctx.ui.notify(describe(ctx.model), 'info')
    },
  })
}
