#!/usr/bin/env node
/**
 * claude-trace — refresh the claude-oauth request details from a live Claude Code request.
 *
 * Runs a local MITM proxy, drives the real `claude` CLI through it (headless
 * `claude -p`), and captures the first real `/v1/messages` request. From that
 * one request it extracts every version/header/body constant the plugin pins,
 * verifies the two values that cannot simply be read off the wire (the `cch`
 * XXH64 seed and the billing-header salt) against the captured bytes, and diffs
 * everything against the current `src/constants.ts`.
 *
 * Why MITM and not `ANTHROPIC_BASE_URL`: Claude Code only sends its full billing
 * header and `cch` value against the real `api.anthropic.com` endpoint. Pointing
 * it at a custom base URL suppresses them, so we transparently intercept
 * `api.anthropic.com` and blind-tunnel everything else.
 *
 * Requirements: Node 24+ (runs `.ts` directly), `openssl` and `claude` on PATH,
 * and a Claude Code that is logged in via OAuth.
 *
 * Usage:
 *   node scripts/claude-trace.ts [options]
 *
 * Options:
 *   --message <text>   Prompt to send (default: hi)
 *   --command <cmd>    Claude binary (default: claude)
 *   --port <n>         Proxy port (default: 8118; 0 = random)
 *   --timeout <ms>     Overall timeout (default: 120000)
 *   --skip <substr>    Skip requests whose model contains this (default: haiku)
 *   --manual           Do not spawn claude; print the env and wait for you to run it
 *   --write            Patch src/constants.ts in place with the captured values
 *   --json             Print the raw captured exchange as JSON
 *   --keep-cert        Leave the generated debug cert on disk (for debugging)
 *   -h, --help         Show this help
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as net from 'node:net'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import * as tls from 'node:tls'
import { fileURLToPath } from 'node:url'

// ── constants ───────────────────────────────────────────────────────────────

const MITM_HOST = 'api.anthropic.com'
const BILLING_PREFIX = 'x-anthropic-billing-header:'
const BILLING_SYSTEM_MARKER = `"system":[{"type":"text","text":"${BILLING_PREFIX}`
// Must stay in sync with src/cch.ts / src/request.ts — the script verifies
// these against the captured bytes and reports a mismatch rather than trusting them.
const CCH_SEED = 0x4d659218e32a3268n
const FINGERPRINT_SALT = '59cf53e54c78'
const FINGERPRINT_INDICES = [4, 7, 20] as const

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
// The captured version/header/body constants the plugin pins all live here, so
// this is the single file --write patches and the report diffs against. writeBack
// relies on each being a plain top-level `export const` (string, number, or
// `as const` array) so its regex patching can find and rewrite it.
const CONSTANTS_FILE = path.join(SCRIPT_DIR, '..', 'src', 'constants.ts')
const encoder = new TextEncoder()

// ── xxh64 (mirror of src/xxhash.ts; kept inline so the script has no imports) ─

const MASK = (1n << 64n) - 1n
const P1 = 11400714785074694791n
const P2 = 14029467366897019727n
const P3 = 1609587929392839161n
const P4 = 9650029242287828579n
const P5 = 2870177450012600261n
const KNOWN_EMPTY_HASH = 0xef46db3751d8e999n

const rotl = (x: bigint, r: bigint): bigint => ((x << r) | (x >> (64n - r))) & MASK
const round = (acc: bigint, input: bigint): bigint =>
  (rotl((acc + input * P2) & MASK, 31n) * P1) & MASK
const mergeRound = (acc: bigint, val: bigint): bigint =>
  ((((acc ^ round(0n, val)) * P1) & MASK) + P4) & MASK

function xxh64(input: Uint8Array, seed: bigint): bigint {
  const len = input.length
  const dv = new DataView(input.buffer, input.byteOffset, input.byteLength)
  let h64: bigint
  let p = 0
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & MASK
    let v2 = (seed + P2) & MASK
    let v3 = seed & MASK
    let v4 = (seed - P1) & MASK
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
    h64 = (seed + P5) & MASK
  }
  h64 = (h64 + BigInt(len)) & MASK
  while (p + 8 <= len) {
    h64 ^= round(0n, dv.getBigUint64(p, true))
    h64 = (((rotl(h64, 27n) * P1) & MASK) + P4) & MASK
    p += 8
  }
  if (p + 4 <= len) {
    h64 ^= (BigInt(dv.getUint32(p, true)) * P1) & MASK
    h64 = (((rotl(h64, 23n) * P2) & MASK) + P3) & MASK
    p += 4
  }
  while (p < len) {
    h64 ^= (BigInt(input[p] ?? 0) * P5) & MASK
    h64 = (rotl(h64, 11n) * P1) & MASK
    p += 1
  }
  h64 ^= h64 >> 33n
  h64 = (h64 * P2) & MASK
  h64 ^= h64 >> 29n
  h64 = (h64 * P3) & MASK
  h64 ^= h64 >> 32n
  return h64 & MASK
}

// ── option parsing ──────────────────────────────────────────────────────────

interface Options {
  message: string
  command: string
  port: number
  timeoutMs: number
  skip: string
  manual: boolean
  write: boolean
  json: boolean
  keepCert: boolean
}

const HELP = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => line.startsWith(' * '))
  .map((line) => line.slice(3))
  .join('\n')

function parseArgs(argv: readonly string[]): Options | 'help' {
  const opts: Options = {
    message: 'hi',
    command: 'claude',
    port: 8118,
    timeoutMs: 120_000,
    skip: 'haiku',
    manual: false,
    write: false,
    json: false,
    keepCert: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const next = (): string => {
      const value = argv[++i]
      if (value === undefined) {
        throw new Error(`${arg} requires a value`)
      }
      return value
    }
    switch (arg) {
      case '-h':
      case '--help':
        return 'help'
      case '--manual':
        opts.manual = true
        break
      case '--write':
        opts.write = true
        break
      case '--json':
        opts.json = true
        break
      case '--keep-cert':
        opts.keepCert = true
        break
      case '--message':
        opts.message = next()
        break
      case '--command':
        opts.command = next()
        break
      case '--skip':
        opts.skip = next()
        break
      case '--port':
        opts.port = Number.parseInt(next(), 10)
        break
      case '--timeout':
        opts.timeoutMs = Number.parseInt(next(), 10)
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }
  return opts
}

// ── self-signed debug certificate ───────────────────────────────────────────

interface DebugCert {
  cert: string
  key: string
  dir: string
}

function generateDebugCert(): DebugCert {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-trace-'))
  const certPath = path.join(dir, 'cert.pem')
  const keyPath = path.join(dir, 'key.pem')
  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-sha256',
      '-days',
      '30',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=claude-trace',
      '-addext',
      `subjectAltName=DNS:${MITM_HOST}`,
    ],
    { stdio: 'pipe' },
  )
  if (result.status !== 0) {
    rmSync(dir, { recursive: true, force: true })
    const detail = result.stderr?.toString().trim() || 'openssl failed'
    throw new Error(`Could not generate debug certificate: ${detail}`)
  }
  return {
    cert: readFileSync(certPath, 'utf8'),
    key: readFileSync(keyPath, 'utf8'),
    dir,
  }
}

// ── minimal HTTP request parser (Content-Length only; no chunked requests) ────

interface CapturedRequest {
  method: string
  target: string
  pathname: string
  headers: Array<{ name: string; value: string }>
  body: string
}

const CRLF2 = Buffer.from('\r\n\r\n')

function headerValue(
  headers: readonly { name: string; value: string }[],
  name: string,
): string | undefined {
  const lower = name.toLowerCase()
  for (const h of headers) {
    if (h.name.toLowerCase() === lower) {
      return h.value
    }
  }
  return undefined
}

class RequestParser {
  #buffer = Buffer.alloc(0)

  push(chunk: Buffer): CapturedRequest[] {
    this.#buffer =
      this.#buffer.length === 0
        ? Buffer.from(chunk)
        : Buffer.concat([this.#buffer, chunk])
    const out: CapturedRequest[] = []
    while (true) {
      const headEnd = this.#buffer.indexOf(CRLF2)
      if (headEnd < 0) {
        break
      }
      const headText = this.#buffer.subarray(0, headEnd).toString('latin1')
      const lines = headText.split('\r\n')
      const [method = '', target = ''] = (lines[0] ?? '').split(/\s+/u)
      const headers: Array<{ name: string; value: string }> = []
      for (let i = 1; i < lines.length; i++) {
        const line = lines[i] ?? ''
        const colon = line.indexOf(':')
        if (colon <= 0) {
          continue
        }
        headers.push({
          name: line.slice(0, colon),
          value: line.slice(colon + 1).trim(),
        })
      }
      const length = Number.parseInt(
        headerValue(headers, 'content-length') ?? '0',
        10,
      )
      const bodyStart = headEnd + CRLF2.length
      if (this.#buffer.length < bodyStart + length) {
        break
      }
      const body = this.#buffer.subarray(bodyStart, bodyStart + length)
      this.#buffer = this.#buffer.subarray(bodyStart + length)
      out.push({
        method,
        target,
        pathname: pathnameOf(target),
        headers,
        body: body.toString('utf8'),
      })
    }
    return out
  }
}

function pathnameOf(target: string): string {
  const q = target.indexOf('?')
  return q >= 0 ? target.slice(0, q) : target
}

// ── MITM proxy ──────────────────────────────────────────────────────────────

interface Capture {
  request: CapturedRequest
  responseStatus?: string
}

interface ConnectTarget {
  host: string
  port: number
}

function parseConnectTarget(raw: string): ConnectTarget | null {
  const colon = raw.lastIndexOf(':')
  if (colon <= 0) {
    return null
  }
  const host = raw.slice(0, colon)
  const port = Number.parseInt(raw.slice(colon + 1), 10)
  if (!host || !Number.isSafeInteger(port) || port <= 0 || port > 65535) {
    return null
  }
  return { host, port }
}

class CaptureProxy {
  readonly #cert: DebugCert
  readonly #skip: string
  readonly #onCapture: (capture: Capture) => void
  readonly #server: net.Server
  #captured = false
  port = 0

  constructor(cert: DebugCert, skip: string, onCapture: (capture: Capture) => void) {
    this.#cert = cert
    this.#skip = skip
    this.#onCapture = onCapture
    this.#server = net.createServer((socket) => this.#onConnection(socket))
    this.#server.on('error', () => {})
  }

  listen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(port, '127.0.0.1', () => {
        const addr = this.#server.address()
        if (addr && typeof addr === 'object') {
          this.port = addr.port
        }
        resolve()
      })
    })
  }

  close(): void {
    this.#server.close()
  }

  #onConnection(socket: net.Socket): void {
    socket.on('error', () => socket.destroy())
    let buffer = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk])
      const end = buffer.indexOf(CRLF2)
      if (end < 0) {
        return
      }
      socket.removeListener('data', onData)
      const headLine = buffer
        .subarray(0, buffer.indexOf(Buffer.from('\r\n')))
        .toString('latin1')
      const rest = buffer.subarray(end + CRLF2.length)
      const [verb, rawTarget = ''] = headLine.split(/\s+/u)
      if (verb !== 'CONNECT') {
        socket.end('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        return
      }
      const target = parseConnectTarget(rawTarget)
      if (!target) {
        socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        return
      }
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n', () => {
        if (rest.length > 0) {
          socket.unshift(rest)
        }
        if (target.host === MITM_HOST) {
          this.#mitm(socket, target)
        } else {
          this.#tunnel(socket, target)
        }
      })
    }
    socket.on('data', onData)
  }

  #tunnel(socket: net.Socket, target: ConnectTarget): void {
    const upstream = net.connect(target.port, target.host)
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.pipe(upstream)
    upstream.pipe(socket)
  }

  #mitm(socket: net.Socket, target: ConnectTarget): void {
    const clientTls = new tls.TLSSocket(socket, {
      isServer: true,
      key: this.#cert.key,
      cert: this.#cert.cert,
      ALPNProtocols: ['http/1.1'],
    })
    const upstream = tls.connect({
      host: target.host,
      port: target.port,
      servername: target.host,
      ALPNProtocols: ['http/1.1'],
    })
    const parser = new RequestParser()
    let awaitingStatus = false
    let pending: CapturedRequest | undefined

    clientTls.on('error', () => upstream.destroy())
    upstream.on('error', () => clientTls.destroy())
    clientTls.pipe(upstream)
    upstream.pipe(clientTls)

    clientTls.on('data', (chunk: Buffer) => {
      if (this.#captured) {
        return
      }
      for (const request of parser.push(chunk)) {
        if (request.pathname !== '/v1/messages') {
          continue
        }
        if (this.#skip && requestModel(request).includes(this.#skip)) {
          continue
        }
        pending = request
        awaitingStatus = true
      }
    })
    upstream.on('data', (chunk: Buffer) => {
      if (!awaitingStatus || !pending || this.#captured) {
        return
      }
      const text = chunk.toString('latin1')
      if (!text.startsWith('HTTP/')) {
        return
      }
      awaitingStatus = false
      this.#captured = true
      this.#onCapture({
        request: pending,
        responseStatus: text.split('\r\n', 1)[0]?.trim(),
      })
    })
  }
}

function requestModel(request: CapturedRequest): string {
  try {
    const parsed = JSON.parse(request.body) as { model?: unknown }
    return typeof parsed.model === 'string' ? parsed.model.toLowerCase() : ''
  } catch {
    return ''
  }
}

// ── fingerprint extraction ──────────────────────────────────────────────────

interface Extracted {
  values: Record<string, string>
  betas: string[]
  billing?: { version: string; suffix: string; entrypoint: string; cch: string }
  identityMarker?: string
  firstUserMessage: string
}

interface AnthropicBody {
  model?: string
  max_tokens?: number
  system?: Array<{ type?: string; text?: string }>
  messages?: Array<{ role?: string; content?: unknown }>
}

function firstUserMessageText(body: AnthropicBody): string {
  for (const message of body.messages ?? []) {
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
          (block as { type?: string }).type === 'text'
        ) {
          const text = (block as { text?: string }).text
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

function userAgentVersions(ua: string): { code?: string; sdk?: string } {
  return {
    code: /claude-cli\/([0-9][0-9.]*)/u.exec(ua)?.[1],
    sdk: /agent-sdk\/([0-9][0-9.]*)/u.exec(ua)?.[1],
  }
}

function extract(request: CapturedRequest): Extracted {
  const values: Record<string, string> = {}
  const ua = headerValue(request.headers, 'user-agent') ?? ''
  const { code, sdk } = userAgentVersions(ua)
  if (code) {
    values['CLAUDE_CODE_VERSION'] = code
  }
  if (sdk) {
    values['CLAUDE_AGENT_SDK_VERSION'] = sdk
  }
  const clientVersion = headerValue(request.headers, 'anthropic-client-version')
  if (clientVersion) {
    values['CLAUDE_CLIENT_VERSION'] = clientVersion
  }
  const stainlessPkg = headerValue(request.headers, 'x-stainless-package-version')
  if (stainlessPkg) {
    values['CLAUDE_CODE_STAINLESS_PACKAGE_VERSION'] = stainlessPkg
  }
  const stainlessRuntime = headerValue(
    request.headers,
    'x-stainless-runtime-version',
  )
  if (stainlessRuntime) {
    values['CLAUDE_CODE_STAINLESS_RUNTIME_VERSION'] = stainlessRuntime
  }

  const betas = (headerValue(request.headers, 'anthropic-beta') ?? '')
    .split(',')
    .map((b) => b.trim())
    .filter(Boolean)

  let body: AnthropicBody = {}
  try {
    body = JSON.parse(request.body) as AnthropicBody
  } catch {
    // leave body empty; extraction just skips body-derived values
  }
  if (typeof body.max_tokens === 'number') {
    values['CLAUDE_CODE_MAX_OUTPUT_TOKENS'] = String(body.max_tokens)
  }

  const systemBlocks = body.system ?? []
  const billingText = systemBlocks.find((b) =>
    b.text?.startsWith(BILLING_PREFIX),
  )?.text
  const identityMarker = systemBlocks.find(
    (b) => !b.text?.startsWith(BILLING_PREFIX),
  )?.text
  let billing: Extracted['billing']
  if (billingText) {
    const version = /cc_version=(\d+\.\d+\.\d+)\.([0-9a-f]{3})/u.exec(billingText)
    const entrypoint = /cc_entrypoint=([^;]+)/u.exec(billingText)?.[1]?.trim()
    const cch = /cch=([0-9a-f]{5})/u.exec(billingText)?.[1]
    if (version && entrypoint && cch) {
      billing = {
        version: version[1] ?? '',
        suffix: version[2] ?? '',
        entrypoint,
        cch,
      }
    }
  }
  if (identityMarker) {
    values['PI_OAUTH_SYSTEM_MARKER'] = identityMarker
  }

  return {
    values,
    betas,
    billing,
    identityMarker,
    firstUserMessage: firstUserMessageText(body),
  }
}

// ── verification against the captured bytes ─────────────────────────────────

interface Verification {
  label: string
  ok: boolean
  detail: string
}

function verify(request: CapturedRequest, extracted: Extracted): Verification[] {
  const checks: Verification[] = []

  // xxh64 sanity: empty-input vector.
  checks.push({
    label: 'xxh64 implementation',
    ok: xxh64(new Uint8Array(0), 0n) === KNOWN_EMPTY_HASH,
    detail: 'XXH64("", seed=0) == 0xef46db3751d8e999',
  })

  // cch seed: zero the captured cch, recompute, compare to the observed value.
  if (extracted.billing) {
    const raw = request.body
    const markerIdx = raw.indexOf(BILLING_SYSTEM_MARKER)
    const cchIdx = markerIdx >= 0 ? raw.indexOf('cch=', markerIdx) : -1
    if (cchIdx >= 0) {
      const zeroed = `${raw.slice(0, cchIdx + 4)}00000${raw.slice(cchIdx + 9)}`
      const computed = (xxh64(encoder.encode(zeroed), CCH_SEED) & 0xfffffn)
        .toString(16)
        .padStart(5, '0')
      checks.push({
        label: 'CCH_SEED (0x4d659218e32a3268)',
        ok: computed === extracted.billing.cch,
        detail: `computed=${computed} observed=${extracted.billing.cch}`,
      })
    }
  }

  // billing fingerprint salt + indices + slice length.
  if (extracted.billing) {
    const msg = extracted.firstUserMessage
    const k = FINGERPRINT_INDICES.map((i) => msg[i] ?? '0').join('')
    const suffix = createHash('sha256')
      .update(`${FINGERPRINT_SALT}${k}${extracted.billing.version}`)
      .digest('hex')
      .slice(0, 3)
    checks.push({
      label: 'billing fingerprint salt/indices',
      ok: suffix === extracted.billing.suffix,
      detail: `computed=${suffix} observed=${extracted.billing.suffix}`,
    })
  }

  return checks
}

// ── diff against current src/constants.ts ─────────────────────────────────────

function currentConstant(source: string, name: string): string | undefined {
  // Match the opening quote, then any run up to the *same* closing quote, so an
  // embedded apostrophe (e.g. "…Anthropic's official CLI…") does not truncate it.
  const stringMatch = new RegExp(
    `${name}\\s*=\\s*(?:\\n\\s*)?(['"\`])((?:\\\\.|(?!\\1)[\\s\\S])*)\\1`,
    'u',
  )
  const numberMatch = new RegExp(`${name}\\s*=\\s*(\\d+)`, 'u')
  return stringMatch.exec(source)?.[2] ?? numberMatch.exec(source)?.[1]
}

function currentBetas(source: string): string[] {
  const block =
    /CLAUDE_CODE_AGENT_BETAS\s*=\s*\[([\s\S]*?)\]/u.exec(source)?.[1] ?? ''
  return [...block.matchAll(/['"]([^'"]+)['"]/gu)].map((m) => m[1] ?? '')
}

// ── reporting ───────────────────────────────────────────────────────────────

const GREEN = '\u001b[32m'
const RED = '\u001b[31m'
const YELLOW = '\u001b[33m'
const DIM = '\u001b[2m'
const RESET = '\u001b[0m'

function report(capture: Capture, extracted: Extracted, source: string): boolean {
  let allGood = true
  const model = requestModel(capture.request)
  console.log(`\n${DIM}captured POST /v1/messages${RESET}`)
  console.log(`  model:    ${model || '(unknown)'}`)
  console.log(`  response: ${capture.responseStatus ?? '(not observed)'}`)
  if (capture.responseStatus && !capture.responseStatus.includes(' 200')) {
    console.log(
      `  ${YELLOW}note: response was not 200 — the request may have been rejected${RESET}`,
    )
  }

  console.log('\nconstants (captured vs current):')
  for (const [name, value] of Object.entries(extracted.values)) {
    const current = currentConstant(source, name)
    const same = current === value
    if (!same) {
      allGood = false
    }
    const mark = same ? `${GREEN}=${RESET}` : `${YELLOW}≠${RESET}`
    const display = name === 'PI_OAUTH_SYSTEM_MARKER' ? JSON.stringify(value) : value
    const currentDisplay =
      current === undefined
        ? `${DIM}(not found)${RESET}`
        : same
          ? `${DIM}unchanged${RESET}`
          : `${DIM}was ${name === 'PI_OAUTH_SYSTEM_MARKER' ? JSON.stringify(current) : current}${RESET}`
    console.log(`  ${mark} ${name}: ${display}  ${currentDisplay}`)
  }

  const currentBetaList = currentBetas(source)
  const betasSame =
    JSON.stringify(currentBetaList) === JSON.stringify(extracted.betas)
  if (!betasSame) {
    allGood = false
  }
  console.log(
    `  ${betasSame ? `${GREEN}=${RESET}` : `${YELLOW}≠${RESET}`} CLAUDE_CODE_AGENT_BETAS (${extracted.betas.length}):`,
  )
  for (const beta of extracted.betas) {
    const known = currentBetaList.includes(beta)
    console.log(`      ${known ? ' ' : `${YELLOW}+${RESET}`} ${beta}`)
  }
  for (const beta of currentBetaList) {
    if (!extracted.betas.includes(beta)) {
      console.log(`      ${RED}-${RESET} ${DIM}${beta}${RESET}`)
    }
  }

  if (extracted.billing) {
    console.log(
      `\n  ${DIM}billing header: cc_entrypoint=${extracted.billing.entrypoint}${RESET}`,
    )
  }

  console.log('\nverification (against captured bytes):')
  for (const check of verify(capture.request, extracted)) {
    if (!check.ok) {
      allGood = false
    }
    const mark = check.ok ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`
    console.log(`  ${mark} ${check.label}  ${DIM}${check.detail}${RESET}`)
  }

  return allGood
}

// ── writing back to src/constants.ts ──────────────────────────────────────────

function writeBack(extracted: Extracted): void {
  let source = readFileSync(CONSTANTS_FILE, 'utf8')
  const changed: string[] = []

  // Function replacements: the captured value is inserted literally, so a `$` in
  // a value can never be reinterpreted as a replacement token.
  const replaceString = (name: string, value: string): void => {
    const re = new RegExp(
      `(${name}\\s*=\\s*(?:\\n\\s*)?)(['"\`])(?:\\\\.|(?!\\2)[\\s\\S])*\\2`,
      'u',
    )
    if (re.test(source)) {
      source = source.replace(
        re,
        (_m, prefix, quote) => `${prefix}${quote}${value}${quote}`,
      )
      changed.push(name)
    }
  }
  const replaceNumber = (name: string, value: string): void => {
    const re = new RegExp(`(${name}\\s*=\\s*)\\d+`, 'u')
    if (re.test(source)) {
      source = source.replace(re, (_m, prefix) => `${prefix}${value}`)
      changed.push(name)
    }
  }

  for (const [name, value] of Object.entries(extracted.values)) {
    if (name === 'CLAUDE_CODE_MAX_OUTPUT_TOKENS') {
      replaceNumber(name, value)
    } else {
      replaceString(name, value)
    }
  }

  if (extracted.betas.length > 0) {
    const rendered = extracted.betas.map((b) => `  '${b}',`).join('\n')
    const re = /(CLAUDE_CODE_AGENT_BETAS\s*=\s*\[)[\s\S]*?(\]\s*as const)/u
    if (re.test(source)) {
      source = source.replace(
        re,
        (_m, open, close) => `${open}\n${rendered}\n${close}`,
      )
      changed.push('CLAUDE_CODE_AGENT_BETAS')
    }
  }

  writeFileSync(CONSTANTS_FILE, source)
  console.log(
    `\n${GREEN}wrote${RESET} ${path.relative(process.cwd(), CONSTANTS_FILE)}`,
  )
  console.log(`  updated: ${changed.join(', ')}`)
  console.log(
    `  ${DIM}run 'pnpm oxfmt' then review 'git diff' before committing${RESET}`,
  )
}

// ── capture orchestration ───────────────────────────────────────────────────

async function run(opts: Options): Promise<void> {
  const cert = generateDebugCert()
  let captureResolve: ((capture: Capture) => void) | undefined
  const proxy = new CaptureProxy(cert, opts.skip, (capture) =>
    captureResolve?.(capture),
  )
  const captured = new Promise<Capture>((resolve, reject) => {
    captureResolve = resolve
    setTimeout(
      () =>
        reject(
          new Error(`timed out after ${opts.timeoutMs}ms waiting for /v1/messages`),
        ),
      opts.timeoutMs,
    ).unref()
  })

  await proxy.listen(opts.port)
  const proxyUrl = `http://127.0.0.1:${proxy.port}`
  console.error(`${DIM}proxy listening on ${proxyUrl}${RESET}`)

  const childEnv = {
    ...process.env,
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
  }

  let child: ReturnType<typeof spawn> | undefined
  let childOutput = ''
  if (opts.manual) {
    console.error('\n--manual: run this in another shell, then send a message:\n')
    console.error(
      `  HTTPS_PROXY=${proxyUrl} NODE_TLS_REJECT_UNAUTHORIZED=0 ${opts.command}\n`,
    )
  } else {
    console.error(
      `${DIM}spawning: ${opts.command} -p ${JSON.stringify(opts.message)}${RESET}`,
    )
    child = spawn(opts.command, ['-p', opts.message], {
      env: childEnv,
      stdio: 'pipe',
    })
    child.stdout?.on('data', (c: Buffer) => (childOutput += c.toString()))
    child.stderr?.on('data', (c: Buffer) => (childOutput += c.toString()))
    child.on('error', (err) => {
      childOutput += `\n[spawn error: ${err.message}]`
    })
  }

  try {
    const capture = await captured
    child?.kill('SIGTERM')

    if (opts.json) {
      console.log(JSON.stringify(capture, null, 2))
      return
    }

    const source = readFileSync(CONSTANTS_FILE, 'utf8')
    const extracted = extract(capture.request)
    const allGood = report(capture, extracted, source)

    if (opts.write) {
      writeBack(extracted)
    } else if (!allGood) {
      console.log(`\n${DIM}run again with --write to patch src/constants.ts${RESET}`)
    } else {
      console.log(`\n${GREEN}request details are already up to date.${RESET}`)
    }
  } catch (error) {
    child?.kill('SIGKILL')
    const message = error instanceof Error ? error.message : String(error)
    const tail = childOutput.trim()
      ? `\n\n${opts.command} output:\n${childOutput.trim()}`
      : ''
    throw new Error(`${message}${tail}`, { cause: error })
  } finally {
    proxy.close()
    if (!opts.keepCert) {
      rmSync(cert.dir, { recursive: true, force: true })
    } else {
      console.error(`${DIM}debug cert kept at ${cert.dir}${RESET}`)
    }
  }
}

// ── entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed === 'help') {
    console.log(HELP)
    return
  }
  await run(parsed)
}

main().catch((error: unknown) => {
  console.error(
    `\n${RED}error:${RESET} ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
