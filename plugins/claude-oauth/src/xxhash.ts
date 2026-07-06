/**
 * XXH64, used to reproduce Claude Code's `cch` request-integrity value. Prefers
 * Bun's native xxHash64, falling back to a BigInt implementation. Both are
 * validated at load against XXH64("", seed=0); if neither matches, `xxh64` is
 * null and callers leave the `cch` value unpatched.
 */

const MASK = (1n << 64n) - 1n
const PRIME64_1 = 11400714785074694791n
const PRIME64_2 = 14029467366897019727n
const PRIME64_3 = 1609587929392839161n
const PRIME64_4 = 9650029242287828579n
const PRIME64_5 = 2870177450012600261n

const KNOWN_EMPTY_HASH = 0xef46db3751d8e999n

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK

const round = (acc: bigint, input: bigint): bigint => {
  const next = (acc + input * PRIME64_2) & MASK
  return (rotl(next, 31n) * PRIME64_1) & MASK
}

const mergeRound = (acc: bigint, val: bigint): bigint => {
  const merged = acc ^ round(0n, val)
  return (((merged * PRIME64_1) & MASK) + PRIME64_4) & MASK
}

export type Xxh64 = (input: Uint8Array, seed: bigint) => bigint

function xxh64Pure(input: Uint8Array, seed: bigint): bigint {
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

declare const Bun:
  | { hash?: { xxHash64?: (data: Uint8Array, seed?: bigint) => bigint } }
  | undefined

function selectXxh64(): Xxh64 | null {
  const bunHash = typeof Bun !== 'undefined' ? Bun?.hash?.xxHash64 : undefined
  if (typeof bunHash === 'function') {
    try {
      if ((bunHash(new Uint8Array(0), 0n) & MASK) === KNOWN_EMPTY_HASH) {
        return (input, seed) => bunHash(input, seed) & MASK
      }
    } catch {
      // Signature differs or rejects a bigint seed — fall through to the pure impl.
    }
  }
  if (xxh64Pure(new Uint8Array(0), 0n) === KNOWN_EMPTY_HASH) {
    return xxh64Pure
  }
  return null
}

export const xxh64: Xxh64 | null = selectXxh64()
