import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { setStatuslineSegment } from '@pi-plugins/shared/statusline'
import { Effect } from 'effect'
import { recentText, streamingText } from './render'
import { SpeedTracker } from './service'

const SEGMENT_KEY = 'speed'

export default function speed(pi: ExtensionAPI) {
  const tracker = Effect.runSync(SpeedTracker.make)

  function showWidget(ctx: ExtensionContext, text: string | undefined): void {
    setStatuslineSegment(
      ctx,
      SEGMENT_KEY,
      text === undefined ? undefined : { text, align: 'left' },
    )
  }

  pi.on('session_start', (_event, ctx) => {
    tracker.reset()
    showWidget(ctx, undefined)
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
    if (firstToken !== undefined) {
      showWidget(ctx, streamingText(tracker.recent(), firstToken))
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
    const recent = tracker.recent()
    showWidget(ctx, recent === undefined ? undefined : recentText(recent))
  })
}
