import { Array, pipe, String } from 'effect'

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

function isPiInternalParagraph(paragraph: string): boolean {
  return (
    paragraph.toLowerCase().includes('you are pi') ||
    PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor))
  )
}

/**
 * Drop pi-internal paragraphs, then rewrite the free-standing word "pi" to
 * "Claude Code". May return an empty string if every paragraph was pi-internal.
 */
export function sanitizeSystemText(text: string): string {
  return pipe(
    text.split(/\n\n+/),
    Array.filter((paragraph) => !isPiInternalParagraph(paragraph)),
    Array.join('\n\n'),
    String.replace(PI_WORD, 'Claude Code'),
    String.trim,
  )
}
