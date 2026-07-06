export const CLAUDE_CODE_VERSION = '2.1.165'
export const CLAUDE_AGENT_SDK_VERSION = '0.3.165'
export const CLAUDE_CLIENT_VERSION = '1.11187.4'
export const CLAUDE_CODE_STAINLESS_PACKAGE_VERSION = '0.94.0'
export const CLAUDE_CODE_STAINLESS_RUNTIME_VERSION = 'v24.3.0'

// Claude Code caps requested output at 64k even when the model ceiling is higher
// (e.g. Opus 128k); OAuth requests clamp to match the client.
export const CLAUDE_CODE_MAX_OUTPUT_TOKENS = 64000

// pi injects this exact block as system[0] on OAuth requests. Its presence is the
// trigger to apply the rest of the Claude Code request details.
export const PI_OAUTH_SYSTEM_MARKER =
  "You are Claude Code, Anthropic's official CLI for Claude."

// Claude Code's agent beta set; order matches the live client.
export const CLAUDE_CODE_AGENT_BETAS = [
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
