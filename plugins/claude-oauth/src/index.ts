import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { wrapFetchForCch } from './cch'
import { rewriteForClaudeCode } from './payload'
import { buildProviderHeaders } from './request'

let fetchWrapped = false

/**
 * Install the `cch` attestation wrapper on the global fetch. The Anthropic SDK
 * resolves `fetch` from the global at client construction and pi builds a fresh
 * client per request, so wrapping here is picked up by every Anthropic call.
 */
function installCchFetchWrapper(): void {
  if (fetchWrapped) {
    return
  }
  const target = globalThis as { fetch?: typeof fetch }
  if (typeof target.fetch !== 'function') {
    return
  }
  target.fetch = wrapFetchForCch(target.fetch.bind(globalThis) as typeof fetch)
  fetchWrapped = true
}

export default function claudeOauth(pi: ExtensionAPI): void {
  installCchFetchWrapper()
  // Header-only registration augments the built-in provider, so OAuth login and
  // models are preserved while the request headers match the current Claude Code client.
  pi.registerProvider('anthropic', { headers: buildProviderHeaders() })

  // Returning the payload replaces it; returning `undefined` leaves it unchanged.
  pi.on('before_provider_request', (event) => rewriteForClaudeCode(event.payload))
}
