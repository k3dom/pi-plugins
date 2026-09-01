import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { wrapFetchForCch } from './cch'
import { buildProviderHeaders, rewriteForClaudeCode } from './request'

let fetchWrapped = false

/**
 * Install the Claude request transport wrapper on the global fetch. The
 * Anthropic SDK resolves `fetch` at client construction, so pi's fresh client
 * picks it up for every request.
 */
function installCchFetchWrapper(): void {
  if (fetchWrapped) {
    return
  }
  const target = globalThis as { fetch?: typeof fetch }
  if (typeof target.fetch !== 'function') {
    return
  }
  target.fetch = wrapFetchForCch(
    target.fetch.bind(globalThis) as typeof fetch,
    buildProviderHeaders(),
  )
  fetchWrapped = true
}

export default function claudeOauth(pi: ExtensionAPI): void {
  installCchFetchWrapper()

  // Returning the payload replaces it; returning `undefined` leaves it unchanged.
  // `short` is also set by @pi-plugins/subagent to prevent extended retention
  // from leaking into the fresh child process through this globally loaded plugin.
  pi.on('before_provider_request', (event) =>
    rewriteForClaudeCode(
      event.payload,
      process.env['PI_CACHE_RETENTION'] !== 'short',
    ),
  )
}
