import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { defaultExtensionConfig, loadExtensionConfig } from '@pi-plugins/shared'
import { Effect, Option, Schema } from 'effect'

const EXTENSION_ID = 'fast-mode'
const COMMAND_ARGS = ['on', 'off', 'status'] as const

type PayloadRecord = Record<string, unknown>

/**
 * How to request fast inference for a given provider API, keyed by the
 * model's `api`. Supporting another provider means adding an entry here
 * (e.g. Anthropic's fast mode uses a `speed` field plus a beta header).
 * OpenAI Responses models opt in via the `service_tier` request field;
 * pi prices the request from the tier echoed back in the response.
 */
const FAST_APPLICATORS: Record<string, (payload: PayloadRecord) => PayloadRecord> = {
  'openai-responses': applyOpenAIPriorityTier,
  'openai-codex-responses': applyOpenAIPriorityTier,
}

function applyOpenAIPriorityTier(payload: PayloadRecord): PayloadRecord {
  // Leave the payload alone when another extension already set a tier.
  if ('service_tier' in payload) return payload
  return { ...payload, service_tier: 'priority' }
}

const DEFAULT_MODELS = [
  'openai/gpt-5.4',
  'openai/gpt-5.5',
  'openai-codex/gpt-5.4',
  'openai-codex/gpt-5.5',
]

const FastModeConfig = Schema.Struct({
  /** Fast-mode state at session start. `/fast` toggles it for the session. */
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** `provider/model-id` keys that fast mode applies to. */
  models: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_MODELS)),
  ),
  /** Show a `fast` indicator in the status line while active. */
  showStatus: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
})

type FastModeConfig = typeof FastModeConfig.Type

const DEFAULT_CONFIG = defaultExtensionConfig(FastModeConfig)

function isRecord(value: unknown): value is PayloadRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

type CurrentModel = ExtensionContext['model']

function modelKey(model: CurrentModel): string {
  return model ? `${model.provider}/${model.id}` : 'no model'
}

export default function fastMode(pi: ExtensionAPI) {
  let config = DEFAULT_CONFIG
  let enabled = false

  function ineligibilityReason(model: CurrentModel): Option.Option<string> {
    if (!model) return Option.some('no model is selected')
    if (!config.models.includes(modelKey(model))) {
      return Option.some(`${modelKey(model)} is not in the configured models`)
    }
    if (!(model.api in FAST_APPLICATORS)) {
      return Option.some(`the ${model.api} API has no fast-mode support`)
    }
    return Option.none()
  }

  function isActive(model: CurrentModel): boolean {
    return enabled && Option.isNone(ineligibilityReason(model))
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    ctx.ui.setStatus(
      EXTENSION_ID,
      config.showStatus && isActive(ctx.model) ? 'fast' : undefined,
    )
  }

  function describe(model: CurrentModel): string {
    if (!enabled) return `Fast mode is off. Current model: ${modelKey(model)}.`

    return Option.match(ineligibilityReason(model), {
      onNone: () => `Fast mode is on for ${modelKey(model)}.`,
      onSome: (reason) => {
        const models = config.models.join(', ') || 'none'
        return `Fast mode is on, but inactive: ${reason}. Configured models: ${models}.`
      },
    })
  }

  pi.registerFlag('fast', {
    description: 'Start with fast mode enabled',
    type: 'boolean',
    default: false,
  })

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
    if (!enabled || !model || !config.models.includes(modelKey(model))) return

    const applyFast = FAST_APPLICATORS[model.api]
    const payload = event.payload
    if (!applyFast || !isRecord(payload) || payload['model'] !== model.id) return

    const next = applyFast(payload)
    return next === payload ? undefined : next
  })

  pi.registerCommand('fast', {
    description:
      'Toggle fast mode (faster, costlier inference) for configured models',
    getArgumentCompletions: (prefix) => {
      const items = COMMAND_ARGS.filter((arg) => arg.startsWith(prefix)).map(
        (arg) => ({ value: arg, label: arg }),
      )
      return items.length > 0 ? items : null
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
