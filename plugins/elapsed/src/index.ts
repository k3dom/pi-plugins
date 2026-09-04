import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'

// pi's own default working message, so the clock reads as an extension of it.
const WORKING_LABEL = 'Working...'
const TICK_MS = 1000

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  const seconds = totalSeconds % 60
  const minutes = Math.floor(totalSeconds / 60) % 60
  const hours = Math.floor(totalSeconds / 3600)

  if (hours > 0) {
    return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`
  }
  if (minutes > 0) {
    return `${minutes}m ${pad(seconds)}s`
  }
  return `${seconds}s`
}

export default function elapsed(pi: ExtensionAPI) {
  let ticker: NodeJS.Timeout | undefined

  function stop(ctx: ExtensionContext): void {
    if (ticker === undefined) {
      return
    }
    clearInterval(ticker)
    ticker = undefined
    ctx.ui.setWorkingMessage()
  }

  pi.on('agent_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }
    stop(ctx)

    const startedAt = performance.now()
    const show = () => {
      ctx.ui.setWorkingMessage(
        `${WORKING_LABEL} ${formatElapsed(performance.now() - startedAt)}`,
      )
    }

    show()
    ticker = setInterval(show, TICK_MS)
    ticker.unref()
  })

  pi.on('agent_end', (_event, ctx) => {
    stop(ctx)
  })

  pi.on('session_shutdown', (_event, ctx) => {
    stop(ctx)
  })
}
