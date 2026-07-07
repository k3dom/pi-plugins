import {
  CCH_PLACEHOLDER,
  CCH_SEED,
  CLAUDE_CODE_BILLING_HEADER_PREFIX,
} from './constants'
import { xxHash64 } from './utils'

const encoder = new TextEncoder()

// Anchor the placeholder to the first system block. The Anthropic SDK serializes
// `messages` before `system`, so these bytes can only appear at the billing
// header we injected; user content in `messages` can never collide with them.
const BILLING_SYSTEM_MARKER = encoder.encode(
  `"system":[{"type":"text","text":"${CLAUDE_CODE_BILLING_HEADER_PREFIX}`,
)
const CCH_PLACEHOLDER_BYTES = encoder.encode(CCH_PLACEHOLDER)
// Placeholder must sit within this many bytes of the marker, else something
// reshaped system[0] and we refuse to patch an unrelated match.
const CCH_SEARCH_WINDOW = 150

type FetchImpl = typeof fetch

/**
 * Wrap fetch so request bodies carrying the `cch=00000` placeholder get their
 * attestation patched in place: `cch=00000` becomes `XXH64(body) & 0xfffff` as 5
 * hex chars. The hash covers the serialized body, so the patch must happen here at
 * the fetch layer rather than on the payload. Every other request passes through
 * byte-for-byte, so a global install is safe.
 */
export function wrapFetchForCch(base: FetchImpl): FetchImpl {
  return (input, init) => {
    const body = init?.body
    if (typeof body !== 'string' || !body.includes(CCH_PLACEHOLDER)) {
      return base(input, init)
    }

    const encoded = encoder.encode(body)
    // Buffer.indexOf is a native memmem; the marker sits near the body's end
    // (messages serialize first), so a hand-rolled scan would walk the whole payload.
    const view = Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER)
    const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length
    const placeholderIdx =
      markerIdx === -1 ? -1 : view.indexOf(CCH_PLACEHOLDER_BYTES, searchFrom)

    if (placeholderIdx === -1 || placeholderIdx - searchFrom > CCH_SEARCH_WINDOW) {
      // Placeholder present but not anchored to system[0]. Send as-is rather than
      // fail the request, but say so.
      console.warn(
        '[claude-oauth] cch placeholder present but not anchored; sending request with cch left unset',
      )
    } else {
      const cch = (xxHash64(encoded, CCH_SEED) & 0xfffffn)
        .toString(16)
        .padStart(5, '0')
      for (let i = 0; i < 5; i++) {
        encoded[placeholderIdx + 4 + i] = cch.charCodeAt(i)
      }
    }

    return base(input, { ...init, body: encoded })
  }
}
