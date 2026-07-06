import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { wrapFetchForCch } from './cch'
import {
  buildProviderHeaders,
  claudeUserId,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  createBillingHeader,
  PI_OAUTH_SYSTEM_MARKER,
} from './fingerprint'
import { sanitizeSystemText } from './system-prompt'

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

// pi injects `system[0] = "You are Claude Code, …"` only on OAuth requests.
// Keying off that marker scopes this to exactly those requests and never touches
// API-key Anthropic traffic or other providers.
function isOAuthAnthropicPayload(payload: AnthropicPayload): boolean {
  return payload.system?.[0]?.text === PI_OAUTH_SYSTEM_MARKER
}

// Rewrite pi's self-references to Claude Code in every system block except the
// identity marker, so the whole prompt stays consistent. Emptied blocks are dropped.
function normalizeSystemBlocks(payload: AnthropicPayload): void {
  const system = payload.system
  if (!system) {
    return
  }
  const normalized: SystemTextBlock[] = []
  for (const block of system) {
    if (
      block?.type !== 'text' ||
      typeof block.text !== 'string' ||
      block.text === PI_OAUTH_SYSTEM_MARKER
    ) {
      normalized.push(block)
      continue
    }
    const text = sanitizeSystemText(block.text)
    if (text) {
      normalized.push({ ...block, text })
    }
  }
  payload.system = normalized
}

/** Text of the first user message — the seed for the billing-header value. */
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

// Bring the request in line with the Claude Code client: prepend the billing-header
// block, set `metadata.user_id`, and clamp `max_tokens`.
function applyClaudeCodeRequest(payload: AnthropicPayload): void {
  // The `cch` placeholder in this block is filled in by the fetch wrapper once
  // the body is serialized.
  const seed = firstUserMessageText(payload.messages)
  payload.system?.unshift({ type: 'text', text: createBillingHeader(seed) })

  if (!payload.metadata || typeof payload.metadata.user_id !== 'string') {
    payload.metadata = { ...payload.metadata, user_id: claudeUserId() }
  }

  if (
    typeof payload.max_tokens === 'number' &&
    payload.max_tokens > CLAUDE_CODE_MAX_OUTPUT_TOKENS
  ) {
    payload.max_tokens = CLAUDE_CODE_MAX_OUTPUT_TOKENS
  }
}

export default function claudeOauth(pi: ExtensionAPI): void {
  installCchFetchWrapper()
  // Header-only registration augments the built-in provider, so OAuth login and
  // models are preserved while the request headers match the current Claude Code client.
  pi.registerProvider('anthropic', { headers: buildProviderHeaders() })

  pi.on('before_provider_request', (event) => {
    const payload = event.payload as AnthropicPayload | null
    // Returning `undefined` leaves the payload unchanged; returning it replaces it.
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.system)) {
      return undefined
    }
    if (!isOAuthAnthropicPayload(payload)) {
      return undefined
    }

    normalizeSystemBlocks(payload)
    applyClaudeCodeRequest(payload)
    return payload
  })
}
