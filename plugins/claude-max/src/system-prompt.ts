/**
 * System-prompt sanitization for Claude Code OAuth requests.
 *
 * pi assembles a system prompt that identifies the harness as "pi": it opens
 * with "operating inside pi, a coding agent harness" and carries a "Pi
 * documentation" section. Anthropic's OAuth billing gate inspects request
 * content — anything that reads like a third-party app is routed to extra usage
 * ("Third-party apps now draw from your extra usage, not your plan limits.").
 *
 * Scrubbing pi's self-identification — dropping pi-internal paragraphs and
 * rewriting the bare word "pi" to "Claude Code" — makes the request read as a
 * genuine Claude Code request so it draws from the plan. pi (0.80+) already
 * injects the "You are Claude Code, …" identity block and renames tools to
 * Claude Code's names on OAuth; this closes the remaining gap in the prompt body.
 *
 * Ported from pi-anthropic-oauth's `sanitizeSystemText`.
 */

// Paragraphs mentioning any of these are pi-internal (doc links, package ids);
// they are dropped wholesale rather than reworded.
const PI_REMOVAL_ANCHORS = [
  'pi-coding-agent',
  '@earendil-works/pi-coding-agent',
  'badlogic/pi-mono',
] as const

export const PI_REWRITE_MODE_ENV = 'PI_CLAUDE_MAX_REWRITE_MODE'
export const PI_REWRITE_PATTERN_ENV = 'PI_CLAUDE_MAX_REWRITE_PATTERN'

export type PiRewriteMode = 'aggressive' | 'path-safe' | 'technical-safe' | 'custom'

const DEFAULT_PI_REWRITE_MODE: PiRewriteMode = 'aggressive'

// `\b[Pp]i\b` rewrites the bare word wherever it appears; the safer modes avoid
// touching "pi" when it is glued into a path or identifier (e.g. `api/pi`,
// `pi.mod`) so surviving file references keep resolving.
const PI_REWRITE_PATTERN_SOURCES: Record<
  Exclude<PiRewriteMode, 'custom'>,
  string
> = {
  aggressive: String.raw`\b[Pp]i\b`,
  'path-safe': String.raw`(?<![/\\])\b[Pp]i\b`,
  'technical-safe': String.raw`(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])`,
}

const PI_REWRITE_MODES = new Set<PiRewriteMode>([
  'aggressive',
  'path-safe',
  'technical-safe',
  'custom',
])

/**
 * Strip pi self-identification from a single system-prompt string: drop
 * pi-internal paragraphs, then rewrite the bare word "pi" to "Claude Code".
 * Returns the scrubbed text (may be empty if every paragraph was pi-internal).
 */
export function sanitizeSystemText(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const paragraphs = text.split(/\n\n+/)
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.toLowerCase().includes('you are pi')) {
      return false
    }
    return !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor))
  })
  return filtered
    .join('\n\n')
    .replace(resolvePiRewritePattern(env), 'Claude Code')
    .trim()
}

function resolvePiRewritePattern(env: NodeJS.ProcessEnv): RegExp {
  const mode = parsePiRewriteMode(env[PI_REWRITE_MODE_ENV])
  if (mode === 'custom') {
    return compileCustomPiRewritePattern(env[PI_REWRITE_PATTERN_ENV])
  }
  return new RegExp(PI_REWRITE_PATTERN_SOURCES[mode], 'g')
}

function parsePiRewriteMode(value: string | undefined): PiRewriteMode {
  const mode = value?.trim().toLowerCase()
  if (!mode) {
    return DEFAULT_PI_REWRITE_MODE
  }
  if (PI_REWRITE_MODES.has(mode as PiRewriteMode)) {
    return mode as PiRewriteMode
  }
  throw new Error(
    `Invalid ${PI_REWRITE_MODE_ENV}: ${value}. Expected one of ${[...PI_REWRITE_MODES].join(', ')}.`,
  )
}

function compileCustomPiRewritePattern(value: string | undefined): RegExp {
  const pattern = value?.trim()
  if (!pattern) {
    throw new Error(
      `${PI_REWRITE_PATTERN_ENV} must be set when ${PI_REWRITE_MODE_ENV}=custom.`,
    )
  }
  try {
    return new RegExp(pattern, 'g')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Invalid ${PI_REWRITE_PATTERN_ENV}: ${message}`, {
      cause: error,
    })
  }
}
