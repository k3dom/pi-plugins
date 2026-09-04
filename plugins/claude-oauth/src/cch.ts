import { randomUUID } from 'node:crypto'
import { Array, pipe, String } from 'effect'
import {
  CCH_PLACEHOLDER,
  CCH_SEED,
  CLAUDE_CODE_BILLING_HEADER_PREFIX,
} from './constants'
import { xxHash64 } from './utils'

const encoder = new TextEncoder()
const BILLING_SYSTEM_MARKER = Buffer.from(
  `"system":[{"type":"text","text":"${CLAUDE_CODE_BILLING_HEADER_PREFIX}`,
)
const CCH_PLACEHOLDER_BYTES = Buffer.from(CCH_PLACEHOLDER)
const MODEL_PREFIX = Buffer.from('"model":"')
const FALLBACKS_PREFIX = Buffer.from('"fallbacks":[')
const MAX_TOKENS_PREFIX = Buffer.from('"max_tokens":')
const FALLBACK_CREDIT_PREFIX = Buffer.from('"fallback_credit_token":"')
const CCH_SEARCH_WINDOW = 150
const COMMA = 0x2c
const QUOTE = 0x22
const BACKSLASH = 0x5c
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d

interface ByteRange {
  start: number
  end: number
}

function findNextIgnoredRange(body: Buffer, offset: number): ByteRange | undefined {
  let earliest: ByteRange | undefined
  const add = (start: number, end: number): void => {
    if (end < body.length && body[end] === COMMA) {
      end++
    } else if (start > offset && body[start - 1] === COMMA) {
      start--
    }
    if (!earliest || start < earliest.start) {
      earliest = { start, end }
    }
  }

  const fallbacksIdx = body.indexOf(FALLBACKS_PREFIX, offset)
  if (fallbacksIdx !== -1) {
    let depth = 1
    let inString = false
    let escaped = false
    for (let i = fallbacksIdx + FALLBACKS_PREFIX.length; i < body.length; i++) {
      const byte = body[i]
      if (inString) {
        if (escaped) {
          escaped = false
        } else if (byte === BACKSLASH) {
          escaped = true
        } else if (byte === QUOTE) {
          inString = false
        }
      } else if (byte === QUOTE) {
        inString = true
      } else if (byte === OPEN_BRACKET) {
        depth++
      } else if (byte === CLOSE_BRACKET && --depth === 0) {
        add(fallbacksIdx, i + 1)
        break
      }
    }
  }

  const creditIdx = body.indexOf(FALLBACK_CREDIT_PREFIX, offset)
  if (creditIdx !== -1) {
    const endQuote = body.indexOf(QUOTE, creditIdx + FALLBACK_CREDIT_PREFIX.length)
    if (endQuote !== -1) {
      add(creditIdx, endQuote + 1)
    }
  }

  let maxTokensIdx = body.indexOf(MAX_TOKENS_PREFIX, offset)
  while (maxTokensIdx !== -1) {
    const valueStart = maxTokensIdx + MAX_TOKENS_PREFIX.length
    let end = valueStart
    while (end < body.length && body[end]! >= 0x30 && body[end]! <= 0x39) {
      end++
    }
    if (end > valueStart) {
      add(maxTokensIdx, end)
      break
    }
    maxTokensIdx = body.indexOf(MAX_TOKENS_PREFIX, valueStart)
  }

  return earliest
}

// Claude excludes mutable routing fields and model values from the attestation.
function canonicalizeForCch(body: Buffer): Buffer {
  const chunks: Buffer[] = []
  let length = 0
  let offset = 0

  const append = (start: number, end: number): void => {
    if (end > start) {
      chunks.push(body.subarray(start, end))
      length += end - start
    }
  }

  while (offset < body.length) {
    const ignored = findNextIgnoredRange(body, offset)
    const modelIdx = body.indexOf(MODEL_PREFIX, offset)

    if (ignored && (modelIdx === -1 || ignored.start < modelIdx)) {
      append(offset, ignored.start)
      offset = ignored.end
      continue
    }

    if (modelIdx !== -1) {
      const valueStart = modelIdx + MODEL_PREFIX.length
      const endQuote = body.indexOf(QUOTE, valueStart)
      if (endQuote !== -1) {
        append(offset, valueStart)
        offset = endQuote
        continue
      }
    }

    break
  }

  append(offset, body.length)
  return chunks.length === 1 && length === body.length
    ? body
    : Buffer.concat(chunks, length)
}

type FetchImpl = typeof fetch

export function wrapFetchForCch(
  base: FetchImpl,
  claudeHeaders: Readonly<Record<string, string>>,
): FetchImpl {
  return (input, init) => {
    const body = init?.body
    if (typeof body !== 'string' || !body.includes(CCH_PLACEHOLDER)) {
      return base(input, init)
    }

    const encoded = Buffer.from(encoder.encode(body))
    const markerIdx = encoded.indexOf(BILLING_SYSTEM_MARKER)
    const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length
    const placeholderIdx =
      markerIdx === -1 ? -1 : encoded.indexOf(CCH_PLACEHOLDER_BYTES, searchFrom)

    if (placeholderIdx === -1 || placeholderIdx - searchFrom > CCH_SEARCH_WINDOW) {
      console.warn(
        '[claude-oauth] cch placeholder present but not anchored; sending request with cch left unset',
      )
      return base(input, init)
    }

    const cch = (xxHash64(canonicalizeForCch(encoded), CCH_SEED) & 0xfffffn)
      .toString(16)
      .padStart(5, '0')
    encoded.write(cch, placeholderIdx + 4, 5, 'ascii')

    const inputHeaders =
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const headers = new Headers(inputHeaders)
    // Pi selects betas for the request fields it emitted. Preserve them when
    // applying Claude Code's baseline so body and header capabilities stay aligned.
    const incomingBetaHeader = headers.get('anthropic-beta') ?? ''
    for (const [name, value] of Object.entries(claudeHeaders)) {
      headers.set(name, value)
    }
    const mergedBetas = pipe(
      [headers.get('anthropic-beta') ?? '', incomingBetaHeader],
      Array.flatMap(String.split(',')),
      Array.map(String.trim),
      Array.filter(String.isNonEmpty),
      Array.dedupe,
    )
    if (mergedBetas.length > 0) {
      headers.set('anthropic-beta', mergedBetas.join(','))
    } else {
      headers.delete('anthropic-beta')
    }
    headers.delete('anthropic-client-platform')
    headers.delete('anthropic-client-version')
    headers.delete('x-claude-code-session-id')
    headers.set('x-client-request-id', randomUUID())

    try {
      const payload = JSON.parse(body) as {
        metadata?: { user_id?: unknown }
      }
      if (typeof payload.metadata?.user_id === 'string') {
        const identity = JSON.parse(payload.metadata.user_id) as {
          session_id?: unknown
        }
        if (typeof identity.session_id === 'string') {
          headers.set('x-claude-code-session-id', identity.session_id)
        }
      }
    } catch {
      headers.delete('x-claude-code-session-id')
    }

    return base(input, { ...init, body: encoded, headers })
  }
}
