import { xxHash64 } from './xxhash'

export const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'
export const CCH_PLACEHOLDER = 'cch=00000'

const CCH_SEED = 0x4d659218e32a3268n

const encoder = new TextEncoder()

// Anchor the placeholder to the first system block. The Anthropic SDK serializes
// `messages` before `system`, so these bytes can only appear at the billing
// header we injected; user content in `messages` can never collide with them.
const BILLING_SYSTEM_MARKER = encoder.encode(
  `"system":[{"type":"text","text":"${BILLING_HEADER_PREFIX}`,
)
const CCH_PLACEHOLDER_BYTES = encoder.encode(CCH_PLACEHOLDER)
// Placeholder must sit within this many bytes of the marker, else something
// reshaped system[0] and we refuse to patch an unrelated match.
const CCH_SEARCH_WINDOW = 150

type PatchResult = 'patched' | 'no-billing-header' | 'unanchored'

function patchCch(body: Uint8Array): PatchResult {
  // Buffer.indexOf is a native memmem; the marker sits near the body's end
  // (messages serialize first), so a hand-rolled scan would walk the whole payload.
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER)
  if (markerIdx === -1) {
    return 'no-billing-header'
  }

  const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length
  const idx = view.indexOf(CCH_PLACEHOLDER_BYTES, searchFrom)
  if (idx === -1 || idx - searchFrom > CCH_SEARCH_WINDOW) {
    return 'unanchored'
  }

  const cch = (xxHash64(body, CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0')
  for (let i = 0; i < 5; i++) {
    body[idx + 4 + i] = cch.charCodeAt(i)
  }
  return 'patched'
}

type FetchImpl = typeof fetch

/**
 * Wrap fetch so request bodies carrying the `cch=00000` placeholder get their
 * attestation patched in place: `cch=00000` becomes `XXH64(body) & 0xfffff` as 5
 * hex chars. The hash covers the serialized body, so the patch must happen here at
 * the fetch layer rather than on the payload. Every other request passes through
 * byte-for-byte, so a global install is safe.
 */
export function wrapFetchForCch(base: FetchImpl): FetchImpl {
  const wrapped: FetchImpl = (input, init) => {
    const body = init?.body
    if (typeof body === 'string' && body.includes(CCH_PLACEHOLDER)) {
      const encoded = encoder.encode(body)
      if (patchCch(encoded) === 'unanchored') {
        // Placeholder present but not anchored to system[0]. Send as-is rather
        // than fail the request, but say so.
        console.warn(
          '[claude-oauth] cch placeholder present but not anchored; sending request with cch left unset',
        )
      }
      return base(input, { ...init, body: encoded })
    }
    return base(input, init)
  }
  return wrapped
}
