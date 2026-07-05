/**
 * Claude Code request fingerprint.
 *
 * Constants and builders that reshape pi's Anthropic OAuth requests to match the
 * current Claude Code client: identity/Stainless headers, the beta set, the
 * `x-anthropic-billing-header` system block, and `metadata.user_id` cloaking.
 *
 * These values are Claude-Code-version-specific. Refresh them from a live capture
 * with `pnpm --filter @pi-plugins/claude-max capture --write` (see
 * `scripts/claude-trace.ts`) whenever Claude Code updates.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  arch as osArch,
  homedir,
  hostname,
  platform as osPlatform,
  userInfo,
} from 'node:os'
import { BILLING_HEADER_PREFIX, CCH_PLACEHOLDER } from './cch'

export const CLAUDE_CODE_VERSION = '2.1.165'
export const CLAUDE_AGENT_SDK_VERSION = '0.3.165'
export const CLAUDE_CLIENT_VERSION = '1.11187.4'
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = '0.94.0'
export const CLAUDE_CODE_STAINLESS_RUNTIME_VERSION = 'v24.3.0'

// Claude Code caps requested output at 64k even when the model ceiling is higher
// (e.g. Opus 128k); OAuth requests clamp to match the wire fingerprint.
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000

// pi injects this exact block as system[0] on OAuth (subscription) requests.
// Its presence is our trigger to upgrade a request to the full fingerprint.
export const PI_OAUTH_SYSTEM_MARKER =
  "You are Claude Code, Anthropic's official CLI for Claude."

// Claude Code's agent beta set (order matches OMP's buildClaudeCodeBetas).
const CLAUDE_CODE_AGENT_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'extended-cache-ttl-2025-04-11',
] as const

function mapStainlessArch(value: string): string {
  switch (value.toLowerCase()) {
    case 'amd64':
    case 'x64':
      return 'x64'
    case 'arm64':
    case 'aarch64':
      return 'arm64'
    case '386':
    case 'x86':
    case 'ia32':
      return 'x86'
    default:
      return `other::${value.toLowerCase()}`
  }
}

function mapStainlessOs(value: string): string {
  switch (value.toLowerCase()) {
    case 'darwin':
      return 'MacOS'
    case 'win32':
    case 'windows':
      return 'Windows'
    case 'linux':
      return 'Linux'
    case 'freebsd':
      return 'FreeBSD'
    default:
      return `Other::${value.toLowerCase()}`
  }
}

/**
 * Static headers merged over pi's Anthropic defaults. pi merges provider headers
 * last, and the Anthropic SDK applies `defaultHeaders` after its auto-generated
 * Stainless/User-Agent headers, so these win while the OAuth Bearer is preserved.
 */
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
 * Build the `x-anthropic-billing-header` text for system[0]. The fingerprint
 * suffix is `SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]`, matching
 * Claude Code's `computeFingerprint`. The `cch=00000` placeholder is patched
 * with the real attestation by the fetch wrapper after serialization.
 */
export function createBillingHeader(firstUserMessageText: string): string {
  const k = [4, 7, 20].map((i) => firstUserMessageText[i] ?? '0').join('')
  const versionSuffix = createHash('sha256')
    .update(`59cf53e54c78${k}${CLAUDE_CODE_VERSION}`)
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
    return `${hostname()}:claude-max-fallback`
  }
}

const deviceId = createHash('sha256')
  .update(`claude-max-device-v1:${resolveMachineSeed()}`)
  .digest('hex')
const sessionId = randomUUID()

export function claudeUserId(): string {
  return JSON.stringify({ device_id: deviceId, session_id: sessionId })
}
