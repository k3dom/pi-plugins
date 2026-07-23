import { createHash, randomUUID } from 'node:crypto'
import {
  arch as osArch,
  homedir,
  hostname,
  platform as osPlatform,
  userInfo,
} from 'node:os'
import { Array, Match, Predicate } from 'effect'
import {
  CCH_PLACEHOLDER,
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CLIENT_VERSION,
  CLAUDE_CODE_AGENT_BETAS,
  CLAUDE_CODE_BILLING_FINGERPRINT_INDICES,
  CLAUDE_CODE_BILLING_FINGERPRINT_SALT,
  CLAUDE_CODE_BILLING_HEADER_PREFIX,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_VERSION,
  PI_OAUTH_SYSTEM_MARKER,
} from './constants'
import { sanitizeSystemText } from './system-prompt'
import { firstUserMessageText, isTextBlock } from './utils'

// The `os.arch()` / `os.platform()` values the SDK reports, mapped to the labels
// Stainless emits. Anything unlisted falls through to an `other::<value>` marker.
const mapStainlessArch = (value: string): string =>
  Match.value(value.toLowerCase()).pipe(
    Match.whenOr('amd64', 'x64', () => 'x64'),
    Match.whenOr('arm64', 'aarch64', () => 'arm64'),
    Match.whenOr('386', 'x86', 'ia32', () => 'x86'),
    Match.orElse((key) => `other::${key}`),
  )

const mapStainlessOs = (value: string): string =>
  Match.value(value.toLowerCase()).pipe(
    Match.when('darwin', () => 'MacOS'),
    Match.whenOr('win32', 'windows', () => 'Windows'),
    Match.when('linux', () => 'Linux'),
    Match.when('freebsd', () => 'FreeBSD'),
    Match.orElse((key) => `Other::${key}`),
  )

// Static headers merged over pi's Anthropic defaults. pi merges provider headers
// last, and the SDK applies `defaultHeaders` after its auto-generated
// Stainless/User-Agent headers, so these win while the OAuth Bearer is preserved.
export function buildProviderHeaders(): Record<string, string> {
  return {
    'user-agent': `claude-cli/${CLAUDE_CODE_VERSION} (external, local-agent, agent-sdk/${CLAUDE_AGENT_SDK_VERSION})`,
    'anthropic-beta': CLAUDE_CODE_AGENT_BETAS.join(','),
    'x-app': 'cli',
    'anthropic-dangerous-direct-browser-access': 'true',
    'x-stainless-retry-count': '0',
    'x-stainless-runtime-version': CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
    'x-stainless-package-version': CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
    'x-stainless-runtime': 'node',
    'x-stainless-lang': 'js',
    'x-stainless-arch': mapStainlessArch(osArch()),
    'x-stainless-os': mapStainlessOs(osPlatform()),
    'x-stainless-timeout': '900',
    'anthropic-client-platform': 'desktop_app',
    'anthropic-client-version': CLAUDE_CLIENT_VERSION,
  }
}

/**
 * Builds the `x-anthropic-billing-header` text for system[0]. The `cch=00000`
 * placeholder is filled in later by the fetch wrapper once the body is serialized.
 */
function createBillingHeader(firstUserMessage: string): string {
  const fingerprintSeed = CLAUDE_CODE_BILLING_FINGERPRINT_INDICES.map(
    (i) => firstUserMessage[i] ?? '0',
  ).join('')
  const versionSuffix = createHash('sha256')
    .update(
      `${CLAUDE_CODE_BILLING_FINGERPRINT_SALT}${fingerprintSeed}${CLAUDE_CODE_VERSION}`,
    )
    .digest('hex')
    .slice(0, 3)
  return `${CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER};`
}

// Claude Code sends `metadata.user_id` as a JSON `{ device_id, session_id }`
// envelope: device_id is machine-stable, session_id is per process. userInfo()
// can throw in locked-down sandboxes, so fall back to a hostname-only seed.
let machineSeed: string
try {
  machineSeed = `${hostname()}:${userInfo().username}:${homedir()}`
} catch {
  machineSeed = `${hostname()}:claude-oauth-fallback`
}
const deviceId = createHash('sha256')
  .update(`claude-oauth-device-v1:${machineSeed}`)
  .digest('hex')
const sessionId = randomUUID()

interface SystemBlock {
  type?: string
  text?: string
}

interface AnthropicPayload {
  messages?: Array<{ role?: string; content?: unknown }>
  system?: SystemBlock[]
  tools?: unknown[]
  max_tokens?: number
  metadata?: { user_id?: unknown }
}

/** Configure an existing cache breakpoint for extended or standard retention. */
function configureCacheTtl(block: unknown, extended: boolean): void {
  if (!Predicate.isObject(block)) {
    return
  }
  const cacheControl = (block as { cache_control?: unknown }).cache_control
  if (!Predicate.isObject(cacheControl)) {
    return
  }
  const typed = cacheControl as { type?: unknown; ttl?: unknown }
  if (typed.type !== 'ephemeral') {
    return
  }
  if (extended) {
    typed.ttl = '1h'
  } else if (typed.ttl === '1h') {
    delete typed.ttl
  }
}

/** Update only the cache breakpoints pi already placed in the payload. */
function configurePayloadCacheTtls(
  payload: AnthropicPayload,
  extended: boolean,
): void {
  for (const block of payload.system ?? []) {
    configureCacheTtl(block, extended)
  }
  for (const tool of payload.tools ?? []) {
    configureCacheTtl(tool, extended)
  }
  for (const message of payload.messages ?? []) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        configureCacheTtl(block, extended)
      }
    }
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
  extendedCacheTtl = true,
): AnthropicPayload | undefined {
  if (!Predicate.isObject(payload)) {
    return undefined
  }
  const typed = payload as AnthropicPayload
  // Only Claude Code OAuth requests carry the identity marker as system[0].
  const system = typed.system
  if (!Array.isArray(system) || system[0]?.text !== PI_OAUTH_SYSTEM_MARKER) {
    return undefined
  }

  // Rewrite pi's self-references to Claude Code in every system block except the
  // identity marker, so the whole prompt stays consistent. Emptied blocks drop out.
  const normalized = Array.flatMap(system, (block) => {
    if (!isTextBlock(block) || block.text === PI_OAUTH_SYSTEM_MARKER) {
      return [block]
    }
    const text = sanitizeSystemText(block.text)
    return text ? [{ ...block, text }] : []
  })

  // Prepend the billing-header block; its `cch` placeholder is filled in by the
  // fetch wrapper once the body is serialized.
  normalized.unshift({
    type: 'text',
    text: createBillingHeader(firstUserMessageText(typed.messages ?? [])),
  })
  typed.system = normalized

  if (!Predicate.isString(typed.metadata?.user_id)) {
    typed.metadata = {
      ...typed.metadata,
      user_id: JSON.stringify({ device_id: deviceId, session_id: sessionId }),
    }
  }

  if (
    Predicate.isNumber(typed.max_tokens) &&
    typed.max_tokens > CLAUDE_CODE_MAX_OUTPUT_TOKENS
  ) {
    typed.max_tokens = CLAUDE_CODE_MAX_OUTPUT_TOKENS
  }

  // The OAuth beta supports one-hour prompt caching. Update the breakpoints pi
  // already emitted without enabling extended retention for other auth modes.
  configurePayloadCacheTtls(typed, extendedCacheTtl)

  return typed
}
