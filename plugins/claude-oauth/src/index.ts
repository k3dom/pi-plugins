import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { wrapFetchForCch } from './cch'
import { buildProviderHeaders, rewriteForClaudeCode } from './request'

let fetchWrapped = false

export default function claudeOauth(pi: ExtensionAPI): void {
  // The Anthropic SDK resolves `fetch` at client construction, so pi's fresh
  // client picks the wrapper up for every request.
  const target = globalThis as { fetch?: typeof fetch }
  if (!fetchWrapped && typeof target.fetch === 'function') {
    target.fetch = wrapFetchForCch(
      target.fetch.bind(globalThis) as typeof fetch,
      buildProviderHeaders(),
    )
    fetchWrapped = true
  }

  pi.on('before_provider_request', (event) => rewriteForClaudeCode(event.payload))
}
