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
  CLAUDE_AGENT_SDK_IDENTITY,
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_AGENT_BETAS,
  CLAUDE_CODE_BILLING_FINGERPRINT_INDICES,
  CLAUDE_CODE_BILLING_FINGERPRINT_SALT,
  CLAUDE_CODE_BILLING_HEADER_PREFIX,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_STAINLESS_TIMEOUT,
  CLAUDE_CODE_VERSION,
  PI_ANTHROPIC_OAUTH_SENTINEL,
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
    'x-stainless-timeout': String(CLAUDE_CODE_STAINLESS_TIMEOUT),
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
  return `${CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER}; cc_prompt_id=${randomUUID()};`
}

// Claude Code sends `metadata.user_id` as a JSON identity envelope: device_id
// is machine-stable and session_id is per process. userInfo()
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
  thinking?: { type?: unknown }
  context_management?: unknown
  diagnostics?: unknown
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
  // Pi only adds this sentinel to Anthropic OAuth payloads.
  const system = typed.system
  if (!Array.isArray(system) || system[0]?.text !== PI_ANTHROPIC_OAUTH_SENTINEL) {
    return undefined
  }

  // Replace the OAuth sentinel with the Agent SDK identity and rewrite pi's
  // self-references in the remaining system blocks. Emptied blocks drop out.
  const normalized = Array.flatMap(system, (block) => {
    if (!isTextBlock(block)) {
      return [block]
    }
    if (block.text === PI_ANTHROPIC_OAUTH_SENTINEL) {
      return [{ ...block, text: CLAUDE_AGENT_SDK_IDENTITY }]
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

  let accountUuid = ''
  if (Predicate.isString(typed.metadata?.user_id)) {
    try {
      const current = JSON.parse(typed.metadata.user_id) as unknown
      if (
        Predicate.isObject(current) &&
        Predicate.isString(current['account_uuid'])
      ) {
        accountUuid = current['account_uuid']
      }
    } catch {
      accountUuid = ''
    }
  }
  typed.metadata = {
    ...typed.metadata,
    user_id: JSON.stringify({
      device_id: deviceId,
      account_uuid: accountUuid,
      session_id: sessionId,
    }),
  }

  if (
    Predicate.isNumber(typed.max_tokens) &&
    typed.max_tokens > CLAUDE_CODE_MAX_OUTPUT_TOKENS
  ) {
    typed.max_tokens = CLAUDE_CODE_MAX_OUTPUT_TOKENS
  }

  if (typed.thinking?.type === 'adaptive' || typed.thinking?.type === 'enabled') {
    typed.context_management = {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    }
  }
  typed.diagnostics = { previous_message_id: null }

  // The OAuth beta supports one-hour prompt caching. Update the breakpoints pi
  // already emitted without enabling extended retention for other auth modes.
  configurePayloadCacheTtls(typed, extendedCacheTtl)

  return typed
}
