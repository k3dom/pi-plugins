import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Array, pipe, String } from 'effect'

export default function exit(pi: ExtensionAPI) {
  pi.on('input', (event, ctx) => {
    const command = pipe(event.text, String.trim, String.toLowerCase)
    if (event.source === 'extension' || !Array.contains(['exit', 'quit'], command)) {
      return { action: 'continue' }
    }

    ctx.shutdown()

    return { action: 'handled' }
  })
}
