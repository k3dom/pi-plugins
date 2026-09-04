export const CLAUDE_CODE_VERSION = '2.1.251'
export const CLAUDE_AGENT_SDK_VERSION = '0.3.251'
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = '0.112.1'
export const CLAUDE_CODE_STAINLESS_RUNTIME_VERSION = 'v26.3.0'
export const CLAUDE_CODE_STAINLESS_TIMEOUT = 600

// Claude Code fingerprints the billing header with
// `SHA256(salt + msg[4] + msg[7] + msg[20] + version)[:3]`. The salt and indices
// are pinned to the client and verified by `scripts/claude-trace.ts`.
export const CLAUDE_CODE_BILLING_FINGERPRINT_SALT = '59cf53e54c78'
export const CLAUDE_CODE_BILLING_FINGERPRINT_INDICES = [4, 7, 20] as const

// The billing header text prepended by the plugin. Its `cch` field starts as the
// placeholder and the fetch wrapper patches in the real request-integrity value.
export const CLAUDE_CODE_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:'
export const CCH_PLACEHOLDER = 'cch=00000'

// Seed for the XXH64 that produces the `cch` value; reverse-engineered from and
// pinned to the client, verified by `scripts/claude-trace.ts`.
export const CCH_SEED = 0x4d659218e32a3268n

// pi injects this exact block as system[0] on OAuth requests. Its presence is the
// trigger to apply the rest of the Claude Code request details.
export const PI_ANTHROPIC_OAUTH_SENTINEL =
  "You are Claude Code, Anthropic's official CLI for Claude."

export const CLAUDE_AGENT_SDK_IDENTITY =
  "You are a Claude agent, built on Anthropic's Claude Agent SDK."

export const CLAUDE_CODE_AGENT_BETAS = [
  'claude-code-20250219',
  'oauth-2025-04-20',
  'context-1m-2025-08-07',
  'interleaved-thinking-2025-05-14',
  'thinking-token-count-2026-05-13',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'mid-conversation-system-2026-04-07',
  'advanced-tool-use-2025-11-20',
  'effort-2025-11-24',
  'fallback-credit-2026-06-01',
  'extended-cache-ttl-2025-04-11',
  'cache-diagnosis-2026-04-07',
] as const

// Pi conditionally installs this beta alongside its model fallbacks. Preserve
// that decision when replacing Pi's beta header with the captured baseline.
export const CLAUDE_CODE_SERVER_FALLBACK_BETA = 'server-side-fallback-2026-07-01'
