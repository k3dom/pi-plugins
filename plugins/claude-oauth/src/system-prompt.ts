/**
 * System-prompt normalization for Claude Code OAuth requests.
 *
 * On OAuth requests pi already injects the Claude Code identity block and renames
 * its tools to Claude Code's names, but the rest of its system prompt still refers
 * to itself as "pi" (doc links, package ids, "you are pi"). Rewriting those
 * leftover self-references to Claude Code keeps the prompt consistent with the
 * Claude Code client.
 */

// Paragraphs mentioning any of these are pi-internal (doc links, package ids)
// and are dropped wholesale.
const PI_REMOVAL_ANCHORS = [
  'pi-coding-agent',
  '@earendil-works/pi-coding-agent',
  'badlogic/pi-mono',
] as const

// Rewrite "pi"/"Pi" only as a standalone word (the harness self-identification).
// The lookbehind/lookahead spare it inside paths and identifiers (`/pi/`,
// `pi-plugins`, `@pi`, `pi.mod`, `pi_x`, `pi:1`).
const PI_WORD = /(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])/g

/**
 * Drop pi-internal paragraphs, then rewrite the free-standing word "pi" to
 * "Claude Code". May return an empty string if every paragraph was pi-internal.
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
