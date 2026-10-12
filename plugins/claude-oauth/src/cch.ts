import { randomUUID } from 'node:crypto'
import { Array, Option, pipe, Predicate, Record, Schema, String } from 'effect'
import * as Constants from './constants'

const encoder = new TextEncoder()
const BILLING_SYSTEM_MARKER = Buffer.from(
  `"system":[{"type":"text","text":"${Constants.CLAUDE_CODE_BILLING_HEADER_PREFIX}`,
)
const CCH_PLACEHOLDER_BYTES = Buffer.from(Constants.CCH_PLACEHOLDER)
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

const MASK = (1n << 64n) - 1n
const PRIME64_1 = 11400714785074694791n
const PRIME64_2 = 14029467366897019727n
const PRIME64_3 = 1609587929392839161n
const PRIME64_4 = 9650029242287828579n
const PRIME64_5 = 2870177450012600261n

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK

const round = (acc: bigint, input: bigint): bigint => {
  const next = (acc + input * PRIME64_2) & MASK
  return (rotl(next, 31n) * PRIME64_1) & MASK
}

const mergeRound = (acc: bigint, val: bigint): bigint => {
  const merged = acc ^ round(0n, val)
  return (((merged * PRIME64_1) & MASK) + PRIME64_4) & MASK
}

function xxHash64(input: Uint8Array, seed: bigint): bigint {
  const len = input.length
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength)
  let h64: bigint
  let p = 0

  if (len >= 32) {
    let v1 = (seed + PRIME64_1 + PRIME64_2) & MASK
    let v2 = (seed + PRIME64_2) & MASK
    let v3 = seed & MASK
    let v4 = (seed - PRIME64_1) & MASK
    const limit = len - 32
    while (p <= limit) {
      v1 = round(v1, dv.getBigUint64(p, true))
      p += 8
      v2 = round(v2, dv.getBigUint64(p, true))
      p += 8
      v3 = round(v3, dv.getBigUint64(p, true))
      p += 8
      v4 = round(v4, dv.getBigUint64(p, true))
      p += 8
    }
    h64 = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & MASK
    h64 = mergeRound(h64, v1)
    h64 = mergeRound(h64, v2)
    h64 = mergeRound(h64, v3)
    h64 = mergeRound(h64, v4)
  } else {
    h64 = (seed + PRIME64_5) & MASK
  }

  h64 = (h64 + BigInt(len)) & MASK

  while (p + 8 <= len) {
    h64 ^= round(0n, dv.getBigUint64(p, true))
    h64 = (rotl(h64, 27n) * PRIME64_1) & MASK
    h64 = (h64 + PRIME64_4) & MASK
    p += 8
  }
  if (p + 4 <= len) {
    h64 ^= (BigInt(dv.getUint32(p, true)) * PRIME64_1) & MASK
    h64 = (rotl(h64, 23n) * PRIME64_2) & MASK
    h64 = (h64 + PRIME64_3) & MASK
    p += 4
  }
  while (p < len) {
    h64 ^= (BigInt(input[p] ?? 0) * PRIME64_5) & MASK
    h64 = (rotl(h64, 11n) * PRIME64_1) & MASK
    p += 1
  }

  h64 ^= h64 >> 33n
  h64 = (h64 * PRIME64_2) & MASK
  h64 ^= h64 >> 29n
  h64 = (h64 * PRIME64_3) & MASK
  h64 ^= h64 >> 32n
  return h64 & MASK
}

function findNextIgnoredRange(body: Buffer, offset: number) {
  let earliest: { start: number; end: number } | undefined
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

// Mutable routing fields and model values are excluded from the attestation.
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

const RequestIdentity = Schema.fromJsonString(
  Schema.Struct({
    metadata: Schema.Struct({
      user_id: Schema.fromJsonString(Schema.Struct({ session_id: Schema.String })),
    }),
  }),
)

export function wrapFetch(
  base: typeof fetch,
  claudeHeaders: Readonly<Record<string, string>>,
): typeof fetch {
  return (input, init) => {
    const body = init?.body
    if (
      !Predicate.isString(body) ||
      !String.includes(Constants.CCH_PLACEHOLDER)(body)
    ) {
      return base(input, init)
    }

    const encoded = Buffer.from(encoder.encode(body))
    const markerIdx = encoded.indexOf(BILLING_SYSTEM_MARKER)
    const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length
    const placeholderIdx =
      markerIdx === -1 ? -1 : encoded.indexOf(CCH_PLACEHOLDER_BYTES, searchFrom)

    if (placeholderIdx === -1 || placeholderIdx - searchFrom > CCH_SEARCH_WINDOW) {
      console.warn(
        '[claude-oauth] cch placeholder present but not anchored — sending request with cch left unset',
      )
      return base(input, init)
    }

    const cch = pipe(
      xxHash64(canonicalizeForCch(encoded), Constants.CCH_SEED) & 0xfffffn,
      (hash) => hash.toString(16),
      String.padStart(5, '0'),
    )
    encoded.write(cch, placeholderIdx + 4, 5, 'ascii')

    const inputHeaders =
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    const headers = new Headers(inputHeaders)
    // Pi's betas match the request fields it emitted, so keep them alongside the
    // baseline.
    const incomingBetaHeader = headers.get('anthropic-beta') ?? ''
    for (const [name, value] of Record.toEntries(claudeHeaders)) {
      headers.set(name, value)
    }
    const mergedBetas = pipe(
      [headers.get('anthropic-beta') ?? '', incomingBetaHeader],
      Array.flatMap(String.split(',')),
      Array.map(String.trim),
      Array.filter(String.isNonEmpty),
      Array.dedupe,
    )
    if (Array.isArrayNonEmpty(mergedBetas)) {
      headers.set('anthropic-beta', Array.join(mergedBetas, ','))
    } else {
      headers.delete('anthropic-beta')
    }
    headers.delete('anthropic-client-platform')
    headers.delete('anthropic-client-version')
    headers.delete('x-claude-code-session-id')
    headers.set('x-client-request-id', randomUUID())

    const identity = Schema.decodeUnknownOption(RequestIdentity)(body)
    if (Option.isSome(identity)) {
      headers.set(
        'x-claude-code-session-id',
        identity.value.metadata.user_id.session_id,
      )
    }

    return base(input, { ...init, body: encoded, headers })
  }
}
