import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { NodeServices } from '@effect/platform-node'
import { loadExtensionConfig } from '@pi-plugins/shared'
import {
  Array,
  Data,
  Effect,
  Match,
  pipe,
  Predicate,
  Record,
  Schema,
  String,
} from 'effect'

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

type ActiveModel = NonNullable<ExtensionContext['model']>
type FastModeApi = 'openai-responses' | 'openai-codex-responses'

function modelKey(model: ActiveModel): string {
  return `${model.provider}/${model.id}`
}

/**
 * Rewrites a provider request payload to ask for fast inference, returning the
 * replacement payload — or `undefined` to leave the request untouched.
 */
type Applicator = (
  payload: Record<string, unknown>,
  model: ActiveModel,
) => Record<string, unknown> | undefined

/** Whether fast mode can apply to the active model. */
type Eligibility = Data.TaggedEnum<{
  Eligible: { readonly apply: Applicator }
  Ineligible: { readonly message: string }
}>
const Eligibility = Data.taggedEnum<Eligibility>()

const FAST_APPLICATORS: Record<string, Applicator> = {
  'openai-responses': applyOpenAIPriorityTier,
  'openai-codex-responses': applyOpenAIPriorityTier,
} satisfies Record<FastModeApi, Applicator>

function applyOpenAIPriorityTier(
  payload: Record<string, unknown>,
): Record<string, unknown> | undefined {
  // If the request already has a `service_tier`, leave it untouched.
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

    const key = modelKey(model)
    if (!config.models.includes(key)) {
      return Eligibility.Ineligible({
        message: `${key} is not in the configured models`,
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

  function notifyState(ctx: ExtensionContext): void {
    const model = ctx.model
    const name = model?.name ?? '(none)'
    const message = !enabled
      ? `Fast mode is off. Current model: ${name}.`
      : Eligibility.$match(checkEligibility(model), {
          Eligible: () => `Fast mode is on for ${name}.`,
          Ineligible: ({ message: reason }) => {
            const models = config.models.join(', ') || 'none'
            return `Fast mode is on, but inactive: ${reason}. Configured models: ${models}.`
          },
        })

    ctx.ui.notify(message, 'info')
  }

  pi.on('session_start', async (_event, ctx) => {
    config = await Effect.runPromise(
      loadExtensionConfig(FastModeConfig, EXTENSION_ID).pipe(
        Effect.orElseSucceed(() => config),
        Effect.provide(NodeServices.layer),
      ),
    )
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
      Match.value(args.trim().toLowerCase()).pipe(
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
