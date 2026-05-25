import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'

const EXIT_COMMANDS = new Set(['exit', 'quit'])

export default function exit(pi: ExtensionAPI) {
  pi.on('input', (event, ctx) => {
    if (
      event.source === 'extension' ||
      !EXIT_COMMANDS.has(event.text.trim().toLowerCase())
    ) {
      return { action: 'continue' }
    }

    ctx.shutdown()

    return { action: 'handled' }
  })
}
