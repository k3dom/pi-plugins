import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import * as Statusline from '@pi-plugins/shared/statusline'
import { Duration, Effect, Option, pipe } from 'effect'
import * as Render from './render'
import * as Tracker from './tracker'

export default function speed(pi: ExtensionAPI) {
  const tracker = Effect.runSync(Tracker.Tracker.make)

  function showWidget(ctx: ExtensionContext, ttft?: Duration.Duration): void {
    const recent =
      ctx.model === undefined
        ? Option.none()
        : Effect.runSync(tracker.recent(`${ctx.model.provider}/${ctx.model.id}`))
    Statusline.setSegment(
      ctx,
      'speed',
      pipe(
        ttft === undefined
          ? Render.recentText(recent)
          : Option.some(Render.streamingText(recent, ttft)),
        Option.map((text): Statusline.Segment => ({ text, align: 'left' })),
        Option.getOrUndefined,
      ),
    )
  }

  pi.on('session_start', (_event, ctx) => {
    Effect.runSync(tracker.reset())
    showWidget(ctx)
  })

  pi.on('model_select', (_event, ctx) => {
    showWidget(ctx)
  })

  pi.on('turn_start', (_event, ctx) => {
    showWidget(ctx)
  })

  pi.on('before_provider_request', () => {
    Effect.runSync(tracker.beginRequest())
  })

  pi.on('message_update', (event, ctx) => {
    const streamEvent = event.assistantMessageEvent
    if (!('delta' in streamEvent)) {
      return
    }
    const ttft = Effect.runSync(
      tracker.recordDelta(
        streamEvent.type === 'thinking_delta' ? 'thinking' : 'visible',
        streamEvent.delta.length,
      ),
    )
    if (
      Option.isSome(ttft) &&
      streamEvent.partial.provider === ctx.model?.provider &&
      streamEvent.partial.model === ctx.model?.id
    ) {
      showWidget(ctx, ttft.value)
    }
  })

  pi.on('message_end', (event, ctx) => {
    const message = event.message
    if (message.role !== 'assistant') {
      return
    }
    Effect.runSync(
      tracker.endRequest({
        model: `${message.provider}/${message.model}`,
        stopReason: message.stopReason,
        outputTokens: message.usage.output,
        reasoningTokens: message.usage.reasoning,
      }),
    )
    showWidget(ctx)
  })
}
