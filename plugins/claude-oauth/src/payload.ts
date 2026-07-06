import { Array, Option, pipe, Predicate, Schema } from 'effect'
import { CLAUDE_CODE_MAX_OUTPUT_TOKENS, PI_OAUTH_SYSTEM_MARKER } from './constants'
import { claudeUserId, createBillingHeader } from './request'
import { sanitizeSystemText } from './system-prompt'

const TextBlock = Schema.Struct({
  type: Schema.Literal('text'),
  text: Schema.String,
})
const isTextBlock = Schema.is(TextBlock)

interface SystemBlock {
  type?: string
  text?: string
}

interface AnthropicPayload {
  messages?: Array<{ role?: string; content?: unknown }>
  system?: SystemBlock[]
  max_tokens?: number
  metadata?: { user_id?: unknown }
}

function isOAuthRequest(payload: AnthropicPayload): boolean {
  const system = payload.system
  return Array.isArray(system) && system[0]?.text === PI_OAUTH_SYSTEM_MARKER
}

// Rewrite pi's self-references to Claude Code in every system block except the
// identity marker, so the whole prompt stays consistent. Emptied blocks are dropped.
function normalizeSystemBlocks(payload: AnthropicPayload): void {
  const system = payload.system
  if (!system) {
    return
  }
  payload.system = Array.flatMap(system, (block) => {
    if (!isTextBlock(block) || block.text === PI_OAUTH_SYSTEM_MARKER) {
      return [block]
    }
    const text = sanitizeSystemText(block.text)
    return text ? [{ ...block, text }] : []
  })
}

/** Concatenated text of the first user message — the seed for the billing header. */
function firstUserMessageText(payload: AnthropicPayload): string {
  return pipe(
    Array.findFirst(payload.messages ?? [], (message) => message.role === 'user'),
    Option.match({
      onNone: () => '',
      onSome: (message) => {
        const content = message.content
        if (Predicate.isString(content)) {
          return content
        }
        if (Array.isArray(content)) {
          return pipe(
            content,
            Array.filter(isTextBlock),
            Array.map((block) => block.text),
            Array.join(''),
          )
        }
        return ''
      },
    }),
  )
}

// Bring the request in line with the Claude Code client: prepend the billing-header
// block, set `metadata.user_id`, and clamp `max_tokens`.
function applyClaudeCodeRequest(payload: AnthropicPayload): void {
  // The `cch` placeholder in this block is filled in by the fetch wrapper once
  // the body is serialized.
  payload.system?.unshift({
    type: 'text',
    text: createBillingHeader(firstUserMessageText(payload)),
  })

  if (!Predicate.isString(payload.metadata?.user_id)) {
    payload.metadata = { ...payload.metadata, user_id: claudeUserId() }
  }

  if (
    Predicate.isNumber(payload.max_tokens) &&
    payload.max_tokens > CLAUDE_CODE_MAX_OUTPUT_TOKENS
  ) {
    payload.max_tokens = CLAUDE_CODE_MAX_OUTPUT_TOKENS
  }
}

/**
 * Rewrites an OAuth Anthropic payload to match the Claude Code client, returning
 * it. Returns `undefined` — leaving the request unchanged — for any payload that
 * is not a Claude Code OAuth request.
 *
 * The payload is mutated in place rather than decoded/re-encoded so that fields
 * this plugin does not model pass through byte-for-byte.
 */
export function rewriteForClaudeCode(
  payload: unknown,
): AnthropicPayload | undefined {
  if (!Predicate.isObject(payload)) {
    return undefined
  }
  const typed = payload as AnthropicPayload
  if (!isOAuthRequest(typed)) {
    return undefined
  }
  normalizeSystemBlocks(typed)
  applyClaudeCodeRequest(typed)
  return typed
}
