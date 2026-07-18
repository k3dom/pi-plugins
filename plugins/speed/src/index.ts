import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import {
  formatMs,
  formatTps,
  renderReport,
  tokensPerSecond,
  type Sample,
} from './stats'

const WIDGET_KEY = 'speed'
/** Oldest samples are dropped beyond this bound. */
const MAX_SAMPLES = 500
/** Minimum time between live status refreshes while streaming. */
const LIVE_UPDATE_INTERVAL_MS = 500
/** Rough chars-per-token heuristic for the live estimate, corrected by real usage at message end. */
const CHARS_PER_TOKEN = 4

/** Measurement of the in-flight provider request, replaced on every new request. */
interface InflightRequest {
  /** `performance.now()` when the request payload was handed to the provider. */
  readonly requestStart: number
  /** `performance.now()` at the first streamed delta; undefined until tokens arrive. */
  firstTokenAt?: number
  /** Streamed characters so far, for the live tok/s estimate. */
  deltaChars: number
  /** Last live status refresh, for throttling. */
  lastLiveUpdate: number
}

function speedText(sample: Sample): string {
  return `${formatTps(tokensPerSecond(sample))} · TTFT ${formatMs(sample.ttftMs)}`
}

export default function speed(pi: ExtensionAPI) {
  const samples: Sample[] = []
  let inflight: InflightRequest | undefined

  /** Renders one measurement line above the editor. */
  function showWidget(ctx: ExtensionContext, text: string | undefined): void {
    ctx.ui.setWidget(
      WIDGET_KEY,
      text === undefined ? undefined : [ctx.ui.theme.fg('dim', text)],
    )
  }

  /** Restores the widget to the last completed measurement, if any. */
  function showLastSample(ctx: ExtensionContext): void {
    const last = samples.at(-1)
    showWidget(ctx, last === undefined ? undefined : speedText(last))
  }

  pi.on('before_provider_request', () => {
    // One LLM request is about to go out; this is the TTFT start anchor.
    inflight = { requestStart: performance.now(), deltaChars: 0, lastLiveUpdate: 0 }
  })

  pi.on('message_update', (event, ctx) => {
    const request = inflight
    const streamEvent = event.assistantMessageEvent
    if (request === undefined || !('delta' in streamEvent)) {
      return
    }

    const now = performance.now()
    request.firstTokenAt ??= now
    request.deltaChars += streamEvent.delta.length

    if (now - request.lastLiveUpdate < LIVE_UPDATE_INTERVAL_MS) {
      return
    }
    request.lastLiveUpdate = now

    const elapsedSeconds = (now - request.firstTokenAt) / 1000
    if (elapsedSeconds <= 0) {
      return
    }
    const estimatedTps = request.deltaChars / CHARS_PER_TOKEN / elapsedSeconds
    showWidget(
      ctx,
      `~${formatTps(estimatedTps)} · TTFT ${formatMs(request.firstTokenAt - request.requestStart)}`,
    )
  })

  pi.on('message_end', (event, ctx) => {
    const message = event.message
    if (message.role !== 'assistant') {
      return
    }

    const request = inflight
    inflight = undefined
    const end = performance.now()

    if (
      request?.firstTokenAt === undefined ||
      message.stopReason === 'error' ||
      message.stopReason === 'aborted' ||
      message.usage.output <= 0
    ) {
      // Nothing measurable (or an interrupted stream): drop the measurement
      // and restore the last completed reading.
      showLastSample(ctx)
      return
    }

    samples.push({
      model: `${message.provider}/${message.model}`,
      ttftMs: request.firstTokenAt - request.requestStart,
      generationMs: Math.max(end - request.firstTokenAt, 1),
      outputTokens: message.usage.output,
      timestamp: Date.now(),
    })
    if (samples.length > MAX_SAMPLES) {
      samples.shift()
    }
    showLastSample(ctx)
  })

  pi.registerCommand('speed', {
    description:
      'Show inference speed for this session (tokens/sec and time to first token)',
    handler: async (_args, ctx) => {
      ctx.ui.notify(renderReport(samples), 'info')
    },
  })
}
