import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

export default function noSpinner(pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') {
      return
    }
    ctx.ui.setWorkingIndicator({ frames: [] })
  })
}
