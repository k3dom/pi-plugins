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
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_STAINLESS_TIMEOUT,
  CLAUDE_CODE_VERSION,
  PI_ANTHROPIC_OAUTH_SENTINEL,
} from './constants'
import { sanitizeSystemText } from './system-prompt'
import { firstUserMessageText, isTextBlock } from './utils'

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
    'x-stainless-arch': Match.value(osArch().toLowerCase()).pipe(
      Match.whenOr('amd64', 'x64', () => 'x64'),
      Match.whenOr('arm64', 'aarch64', () => 'arm64'),
      Match.whenOr('386', 'x86', 'ia32', () => 'x86'),
      Match.orElse((key) => `other::${key}`),
    ),
    'x-stainless-os': Match.value(osPlatform().toLowerCase()).pipe(
      Match.when('darwin', () => 'MacOS'),
      Match.whenOr('win32', 'windows', () => 'Windows'),
      Match.when('linux', () => 'Linux'),
      Match.when('freebsd', () => 'FreeBSD'),
      Match.orElse((key) => `Other::${key}`),
    ),
    'x-stainless-timeout': String(CLAUDE_CODE_STAINLESS_TIMEOUT),
  }
}

// `userInfo()` can throw in locked-down sandboxes.
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
  metadata?: { user_id?: unknown }
  thinking?: { type?: unknown }
  context_management?: unknown
  diagnostics?: unknown
}

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

// Mutated in place so fields this plugin does not model pass through untouched.
export function rewriteForClaudeCode(
  payload: unknown,
  extendedCacheTtl = true,
): AnthropicPayload | undefined {
  if (!Predicate.isObject(payload)) {
    return undefined
  }
  const typed = payload as AnthropicPayload
  const system = typed.system
  if (!Array.isArray(system) || system[0]?.text !== PI_ANTHROPIC_OAUTH_SENTINEL) {
    return undefined
  }

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

  const firstUserMessage = firstUserMessageText(typed.messages ?? [])
  const fingerprintSeed = CLAUDE_CODE_BILLING_FINGERPRINT_INDICES.map(
    (i) => firstUserMessage[i] ?? '0',
  ).join('')
  const versionSuffix = createHash('sha256')
    .update(
      `${CLAUDE_CODE_BILLING_FINGERPRINT_SALT}${fingerprintSeed}${CLAUDE_CODE_VERSION}`,
    )
    .digest('hex')
    .slice(0, 3)
  normalized.unshift({
    type: 'text',
    text: `${CLAUDE_CODE_BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER}; cc_prompt_id=${randomUUID()};`,
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

  if (typed.thinking?.type === 'adaptive' || typed.thinking?.type === 'enabled') {
    typed.context_management = {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    }
  }
  typed.diagnostics = { previous_message_id: null }

  for (const block of typed.system) {
    configureCacheTtl(block, extendedCacheTtl)
  }
  for (const tool of typed.tools ?? []) {
    configureCacheTtl(tool, extendedCacheTtl)
  }
  for (const message of typed.messages ?? []) {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        configureCacheTtl(block, extendedCacheTtl)
      }
    }
  }

  return typed
}
