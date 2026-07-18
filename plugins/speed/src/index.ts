import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Effect } from 'effect'
import { liveText, renderReport, sampleText } from './render'
import { SpeedTracker } from './service'

const WIDGET_KEY = 'speed'

export default function speed(pi: ExtensionAPI) {
  const tracker = Effect.runSync(SpeedTracker.make)

  /** Renders one measurement line above the editor. */
  function showWidget(ctx: ExtensionContext, text: string | undefined): void {
    ctx.ui.setWidget(
      WIDGET_KEY,
      text === undefined ? undefined : [ctx.ui.theme.fg('dim', text)],
    )
  }

  function showLastSample(ctx: ExtensionContext): void {
    const last = tracker.lastSample()
    showWidget(ctx, last === undefined ? undefined : sampleText(last))
  }

  pi.on('before_provider_request', () => {
    tracker.beginRequest()
  })

  pi.on('message_update', (event, ctx) => {
    const streamEvent = event.assistantMessageEvent
    if (!('delta' in streamEvent)) {
      return
    }
    const estimate = tracker.recordDelta(streamEvent.delta.length)
    if (estimate !== undefined) {
      showWidget(ctx, liveText(estimate))
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
    })
    showLastSample(ctx)
  })

  pi.registerCommand('speed', {
    description:
      'Show inference speed for this session (tokens/sec and time to first token)',
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderReport(tracker.report()), 'info')
    },
  })
}
