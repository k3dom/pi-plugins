import { createHash, randomUUID } from 'node:crypto'
import {
  arch as osArch,
  homedir,
  hostname,
  platform as osPlatform,
  userInfo,
} from 'node:os'
import { BILLING_HEADER_PREFIX, CCH_PLACEHOLDER } from './cch'
import {
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CLIENT_VERSION,
  CLAUDE_CODE_AGENT_BETAS,
  CLAUDE_CODE_STAINLESS_PACKAGE_VERSION,
  CLAUDE_CODE_STAINLESS_RUNTIME_VERSION,
  CLAUDE_CODE_VERSION,
} from './constants'

// The `os.arch()` / `os.platform()` values the SDK reports, mapped to the labels
// Stainless emits. Anything unlisted falls through to an `other::<value>` marker.
const STAINLESS_ARCH: Record<string, string> = {
  amd64: 'x64',
  x64: 'x64',
  arm64: 'arm64',
  aarch64: 'arm64',
  '386': 'x86',
  x86: 'x86',
  ia32: 'x86',
}

const STAINLESS_OS: Record<string, string> = {
  darwin: 'MacOS',
  win32: 'Windows',
  windows: 'Windows',
  linux: 'Linux',
  freebsd: 'FreeBSD',
}

function mapStainlessArch(value: string): string {
  const key = value.toLowerCase()
  return STAINLESS_ARCH[key] ?? `other::${key}`
}

function mapStainlessOs(value: string): string {
  const key = value.toLowerCase()
  return STAINLESS_OS[key] ?? `Other::${key}`
}

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

// Claude Code fingerprints the billing header with
// `SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]`. The salt and indices
// are pinned to the client and verified by `scripts/claude-trace.ts`.
const BILLING_FINGERPRINT_SALT = '59cf53e54c78'
const BILLING_FINGERPRINT_INDICES = [4, 7, 20] as const

/**
 * Builds the `x-anthropic-billing-header` text for system[0]. The `cch=00000`
 * placeholder is filled in later by the fetch wrapper once the body is serialized.
 */
export function createBillingHeader(firstUserMessage: string): string {
  const fingerprintSeed = BILLING_FINGERPRINT_INDICES.map(
    (i) => firstUserMessage[i] ?? '0',
  ).join('')
  const versionSuffix = createHash('sha256')
    .update(`${BILLING_FINGERPRINT_SALT}${fingerprintSeed}${CLAUDE_CODE_VERSION}`)
    .digest('hex')
    .slice(0, 3)
  return `${BILLING_HEADER_PREFIX} cc_version=${CLAUDE_CODE_VERSION}.${versionSuffix}; cc_entrypoint=local-agent; ${CCH_PLACEHOLDER};`
}

// Claude Code sends `metadata.user_id` as a JSON `{ device_id, session_id }`
// envelope. device_id is machine-stable; session_id is per process.
function resolveMachineSeed(): string {
  try {
    // userInfo() can throw in locked-down sandboxes; hostname/homedir are safe.
    return `${hostname()}:${userInfo().username}:${homedir()}`
  } catch {
    return `${hostname()}:claude-oauth-fallback`
  }
}

const deviceId = createHash('sha256')
  .update(`claude-oauth-device-v1:${resolveMachineSeed()}`)
  .digest('hex')
const sessionId = randomUUID()

export function claudeUserId(): string {
  return JSON.stringify({ device_id: deviceId, session_id: sessionId })
}
