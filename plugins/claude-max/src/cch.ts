/**
 * Claude Code `cch` billing-header attestation.
 *
 * Claude Code injects a synthetic first system block:
 *
 *   x-anthropic-billing-header: cc_version=...; cc_entrypoint=local-agent; cch=00000;
 *
 * and then, at the fetch layer (after the body is serialized), replaces the
 * `cch=00000` placeholder with `XXH64(body, seed) & 0xfffff` rendered as 5 hex
 * chars. Because the hash is over the final bytes, this must happen after
 * serialization — which is why the plugin wraps `globalThis.fetch` rather than
 * only editing the payload object. This is a direct port of OMP's
 * `wrapFetchForCch` (packages/ai/src/providers/anthropic.ts).
 */

import { xxh64 } from './xxhash'

export const BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'
export const CCH_PLACEHOLDER = 'cch=00000'

// XXH64 seed Claude Code uses for the attestation.
const CCH_SEED = 0x4d659218e32a3268n

const encoder = new TextEncoder()

// Anchor the placeholder to the *first system block*. The Anthropic SDK
// serializes `messages` before `system`, so this exact byte sequence can only
// appear where we inject the billing header (system[0]); user content in
// `messages` can never collide with it.
const BILLING_SYSTEM_MARKER = encoder.encode(
  `"system":[{"type":"text","text":"${BILLING_HEADER_PREFIX}`,
)
const CCH_PLACEHOLDER_BYTES = encoder.encode(CCH_PLACEHOLDER)
// The placeholder must sit within this many bytes after the marker, otherwise
// something reshaped system[0] and we refuse to patch an unrelated match.
const CCH_SEARCH_WINDOW = 150

type PatchResult = 'patched' | 'no-billing-header' | 'unanchored' | 'unavailable'

function patchCch(body: Uint8Array): PatchResult {
  if (!xxh64) return 'unavailable'

  // Buffer.indexOf is a native memmem; the marker sits ~99% through the body
  // (messages serialize first), so a hand-rolled scan would walk the whole payload.
  const view = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  const markerIdx = view.indexOf(BILLING_SYSTEM_MARKER)
  if (markerIdx === -1) return 'no-billing-header'

  const searchFrom = markerIdx + BILLING_SYSTEM_MARKER.length
  const idx = view.indexOf(CCH_PLACEHOLDER_BYTES, searchFrom)
  if (idx === -1 || idx - searchFrom > CCH_SEARCH_WINDOW) return 'unanchored'

  const cch = (xxh64(body, CCH_SEED) & 0xfffffn).toString(16).padStart(5, '0')
  for (let i = 0; i < 5; i++) body[idx + 4 + i] = cch.charCodeAt(i)
  return 'patched'
}

type FetchImpl = typeof fetch

/**
 * Wrap a fetch implementation so that outgoing request bodies carrying the
 * `cch=00000` placeholder get their attestation patched in place. Every other
 * request passes through byte-for-byte untouched, so a global install is safe.
 */
export function wrapFetchForCch(base: FetchImpl): FetchImpl {
  const wrapped: FetchImpl = (input, init) => {
    const body = init?.body
    if (typeof body === 'string' && body.includes(CCH_PLACEHOLDER)) {
      const encoded = encoder.encode(body)
      if (patchCch(encoded) === 'unanchored') {
        // Placeholder present but not anchored to system[0] (e.g. another hook
        // reshaped the block). Send as-is rather than fail the request, but say so.
        console.warn(
          '[claude-max] cch placeholder present but not anchored; sending unattested request',
        )
      }
      return base(input, { ...init, body: encoded })
    }
    return base(input, init)
  }
  return wrapped
}
