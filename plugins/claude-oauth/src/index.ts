import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { Predicate } from 'effect'
import * as Cch from './cch'
import * as ClaudeCode from './claude-code'

let fetchWrapped = false

export default function claudeOauth(pi: ExtensionAPI): void {
  // The Anthropic SDK resolves `fetch` at client construction, so pi's fresh
  // client picks the wrapper up for every request.
  const target = globalThis as { fetch?: typeof fetch }
  if (!fetchWrapped && Predicate.isFunction(target.fetch)) {
    target.fetch = Cch.wrapFetch(
      target.fetch.bind(globalThis) as typeof fetch,
      ClaudeCode.headers(),
    )
    fetchWrapped = true
  }

  pi.on('before_provider_request', (event) => ClaudeCode.rewrite(event.payload))
}
