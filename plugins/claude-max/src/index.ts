import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { wrapFetchForCch } from './cch'
import {
  buildProviderHeaders,
  claudeUserId,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  createBillingHeader,
  PI_OAUTH_SYSTEM_MARKER,
} from './fingerprint'

interface SystemTextBlock {
  type: string
  text?: string
}

interface AnthropicPayload {
  model?: string
  messages?: Array<{ role?: string; content?: unknown }>
  system?: SystemTextBlock[]
  max_tokens?: number
  metadata?: { user_id?: unknown }
}

let fetchWrapped = false

/**
 * Install the `cch` attestation wrapper on the global fetch. The Anthropic SDK
 * (0.9x) resolves `fetch` from the global at client construction, and pi builds
 * a fresh client per request, so wrapping here — before any request — is picked
 * up by every Anthropic call. The wrapper is a pass-through for everything that
 * does not carry the billing placeholder.
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

/**
 * pi injects `system[0] = "You are Claude Code, …"` only on OAuth (subscription)
 * Anthropic requests. Keying off that marker means we upgrade exactly those
 * requests and never touch API-key Anthropic traffic or other providers.
 */
function isOAuthAnthropicPayload(payload: AnthropicPayload): boolean {
  return payload.system?.[0]?.text === PI_OAUTH_SYSTEM_MARKER
}

/** Text of the first user message — the seed for the billing-header fingerprint. */
function firstUserMessageText(messages: AnthropicPayload['messages']): string {
  if (!messages) {
    return ''
  }
  for (const message of messages) {
    if (message.role !== 'user') {
      continue
    }
    const content = message.content
    if (typeof content === 'string') {
      return content
    }
    if (Array.isArray(content)) {
      const parts: string[] = []
      for (const block of content) {
        if (
          block &&
          typeof block === 'object' &&
          (block as SystemTextBlock).type === 'text'
        ) {
          const text = (block as SystemTextBlock).text
          if (typeof text === 'string') {
            parts.push(text)
          }
        }
      }
      return parts.join('')
    }
    return ''
  }
  return ''
}

export default function claudeMax(pi: ExtensionAPI): void {
  if (process.env['PI_CLAUDE_MAX_DISABLE'] === '1') {
    return
  }

  installCchFetchWrapper()

  // Refresh the Anthropic request fingerprint (User-Agent, betas, Stainless /
  // client headers) to match current Claude Code. Header-only registration
  // augments the built-in provider — OAuth login and models are preserved.
  pi.registerProvider('anthropic', { headers: buildProviderHeaders() })

  pi.on('before_provider_request', (event) => {
    const payload = event.payload as AnthropicPayload | null
    // Returning `undefined` leaves the payload unchanged (pi's documented
    // before_provider_request contract); returning `payload` replaces it.
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.system)) {
      return undefined
    }
    if (!isOAuthAnthropicPayload(payload)) {
      return undefined
    }

    // 1. Prepend the Claude Code billing-header block as system[0]. The `cch`
    //    placeholder is attested by the global fetch wrapper after serialization.
    const seed = firstUserMessageText(payload.messages)
    payload.system.unshift({ type: 'text', text: createBillingHeader(seed) })

    // 2. Cloak metadata.user_id into the Claude Code attribution shape.
    if (!payload.metadata || typeof payload.metadata.user_id !== 'string') {
      payload.metadata = { ...payload.metadata, user_id: claudeUserId() }
    }

    // 3. Clamp output tokens to Claude Code's 64k wire ceiling.
    if (
      typeof payload.max_tokens === 'number' &&
      payload.max_tokens > CLAUDE_CODE_MAX_OUTPUT_TOKENS
    ) {
      payload.max_tokens = CLAUDE_CODE_MAX_OUTPUT_TOKENS
    }

    return payload
  })
}
