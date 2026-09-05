import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { setStatuslineSegment } from '@pi-plugins/shared/statusline'
import { recentText, streamingText } from './render'
import { createSpeedTracker, type FirstToken } from './service'

const SEGMENT_KEY = 'speed'

export default function speed(pi: ExtensionAPI) {
  const tracker = createSpeedTracker()

  function showWidget(ctx: ExtensionContext, firstToken?: FirstToken): void {
    const recent =
      ctx.model === undefined
        ? undefined
        : tracker.recent(`${ctx.model.provider}/${ctx.model.id}`)
    const text =
      firstToken === undefined
        ? recentText(recent)
        : streamingText(recent, firstToken)
    setStatuslineSegment(
      ctx,
      SEGMENT_KEY,
      text === undefined ? undefined : { text, align: 'left' },
    )
  }

  pi.on('session_start', (_event, ctx) => {
    tracker.reset()
    showWidget(ctx)
  })

  pi.on('model_select', (_event, ctx) => {
    showWidget(ctx)
  })

  pi.on('turn_start', (_event, ctx) => {
    showWidget(ctx)
  })

  pi.on('before_provider_request', () => {
    tracker.beginRequest()
  })

  pi.on('message_update', (event, ctx) => {
    const streamEvent = event.assistantMessageEvent
    if (!('delta' in streamEvent)) {
      return
    }
    const firstToken = tracker.recordDelta(
      streamEvent.type === 'thinking_delta' ? 'thinking' : 'visible',
      streamEvent.delta.length,
    )
    if (
      firstToken !== undefined &&
      streamEvent.partial.provider === ctx.model?.provider &&
      streamEvent.partial.model === ctx.model?.id
    ) {
      showWidget(ctx, firstToken)
    }
  })

  pi.on('message_end', (event, ctx) => {
    const message = event.message
    if (message.role !== 'assistant') {
      return
    }
    tracker.endRequest({
      model: `${message.provider}/${message.model}`,
      stopReason: message.stopReason,
      outputTokens: message.usage.output,
      reasoningTokens: message.usage.reasoning,
    })
    showWidget(ctx)
  })
}
