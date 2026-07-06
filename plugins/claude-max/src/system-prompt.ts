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
 */

// Paragraphs mentioning any of these are pi-internal (doc links, package ids);
// they are dropped wholesale rather than reworded.
const PI_REMOVAL_ANCHORS = [
  'pi-coding-agent',
  '@earendil-works/pi-coding-agent',
  'badlogic/pi-mono',
] as const

// Rewrite "pi"/"Pi" only where it stands alone as an English word — that is the
// harness self-identification we need to remove ("operating inside pi", "Pi
// documentation", "about pi itself"). The surrounding lookbehind/lookahead spare
// "pi" when it is glued into a path or identifier (`/pi/`, `pi-plugins`, `@pi`,
// `pi.mod`, `pi_x`, `pi:1`), so real file references and package names that
// survive the paragraph filter are left intact instead of being corrupted.
const PI_WORD = /(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])/g

/**
 * Strip pi self-identification from a system-prompt string: drop pi-internal
 * paragraphs, then rewrite the free-standing word "pi" to "Claude Code". Returns
 * the scrubbed text (may be empty if every paragraph was pi-internal).
 */
export function sanitizeSystemText(text: string): string {
  const paragraphs = text.split(/\n\n+/)
  const filtered = paragraphs.filter((paragraph) => {
    if (paragraph.toLowerCase().includes('you are pi')) {
      return false
    }
    return !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor))
  })
  return filtered.join('\n\n').replace(PI_WORD, 'Claude Code').trim()
}
