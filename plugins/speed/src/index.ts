import { performance } from 'node:perf_hooks'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Array, Match, pipe, String } from 'effect'
import { makeSpeedTracker, type FirstOutputKind, type SpeedTracker } from './metrics'
import {
  renderPendingStatus,
  renderRecent,
  renderReport,
  renderSampleStatus,
  renderStreamingStatus,
} from './render'

const STATUS_ID = 'speed'
const COMMAND_ARGS = ['status', 'recent', 'reset'] as const

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
  if (ctx.hasUI) {
    ctx.ui.setStatus(STATUS_ID, value)
  }
}

function markFirstOutput(
  tracker: SpeedTracker,
  kind: FirstOutputKind,
  ctx: ExtensionContext,
): void {
  const measurement = tracker.markFirstOutput(kind)
  if (measurement?.firstOutputAt !== undefined) {
    setStatus(
      ctx,
      renderStreamingStatus(measurement.firstOutputAt - measurement.requestAt),
    )
  }
}

export default function speed(pi: ExtensionAPI): void {
  const tracker = makeSpeedTracker(() => performance.now())

  pi.on('session_start', (_event, ctx) => {
    tracker.resetSession()
    setStatus(ctx, undefined)
  })

  pi.on('before_provider_request', (_event, ctx) => {
    tracker.start()
    setStatus(ctx, renderPendingStatus())
  })

  pi.on('after_provider_response', () => {
    tracker.markResponse()
  })

  pi.on('message_update', (event, ctx) => {
    const streamEvent = event.assistantMessageEvent
    switch (streamEvent.type) {
      case 'text_start': {
        const content = streamEvent.partial.content[streamEvent.contentIndex]
        if (content?.type === 'text' && content.text.length > 0) {
          markFirstOutput(tracker, 'text', ctx)
        }
        break
      }
      case 'text_delta':
        if (streamEvent.delta.length > 0) {
          markFirstOutput(tracker, 'text', ctx)
        }
        break
      case 'thinking_start': {
        const content = streamEvent.partial.content[streamEvent.contentIndex]
        if (
          content?.type === 'thinking' &&
          (content.thinking.length > 0 || content.redacted === true)
        ) {
          markFirstOutput(tracker, 'thinking', ctx)
        }
        break
      }
      case 'thinking_delta':
        if (streamEvent.delta.length > 0) {
          markFirstOutput(tracker, 'thinking', ctx)
        }
        break
      case 'toolcall_start':
        // Tool metadata is already provider output. Some no-argument tool calls
        // never produce a non-empty argument delta.
        markFirstOutput(tracker, 'tool', ctx)
        break
      case 'toolcall_delta':
        if (streamEvent.delta.length > 0) {
          markFirstOutput(tracker, 'tool', ctx)
        }
        break
    }
  })

  pi.on('message_end', (event, ctx) => {
    if (event.message.role !== 'assistant') {
      return
    }

    const sample = tracker.finish({
      provider: event.message.provider,
      model: event.message.responseModel ?? event.message.model,
      stopReason: event.message.stopReason,
      outputTokens: event.message.usage.output,
    })
    if (sample) {
      setStatus(ctx, renderSampleStatus(sample))
    }
  })

  // A provider failure before an assistant message is created can leave a
  // request open. Never carry that timing into a later agent run.
  pi.on('agent_end', (_event, ctx) => {
    if (tracker.abandon()) {
      setStatus(ctx, undefined)
    }
  })

  pi.on('session_shutdown', (_event, ctx) => {
    tracker.resetSession()
    setStatus(ctx, undefined)
  })

  pi.registerCommand('speed', {
    description: 'Show inference TPS and time-to-first-token metrics',
    getArgumentCompletions: (prefix) => {
      const items = pipe(
        COMMAND_ARGS,
        Array.filter(String.startsWith(prefix)),
        Array.map((arg) => ({ value: arg, label: arg })),
      )
      return Array.match(items, {
        onEmpty: () => null,
        onNonEmpty: (matched) => [...matched],
      })
    },
    handler: async (args, ctx) => {
      Match.value(args.trim().toLowerCase()).pipe(
        Match.whenOr('', 'status', () => {
          ctx.ui.notify(renderReport(tracker.samples()), 'info')
        }),
        Match.when('recent', () => {
          ctx.ui.notify(renderRecent(tracker.samples()), 'info')
        }),
        Match.when('reset', () => {
          tracker.resetHistory()
          if (!tracker.active()) {
            setStatus(ctx, undefined)
          }
          ctx.ui.notify('Inference speed history reset.', 'info')
        }),
        Match.orElse(() => {
          ctx.ui.notify('Usage: /speed [status|recent|reset]', 'warning')
        }),
      )
    },
  })
}
