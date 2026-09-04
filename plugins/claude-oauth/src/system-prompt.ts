import { Array, pipe, String } from 'effect'

const PI_REMOVAL_ANCHORS = [
  'pi-coding-agent',
  '@earendil-works/pi-coding-agent',
  'badlogic/pi-mono',
] as const

const PI_DOCUMENTATION_HEADING =
  'Pi documentation (read only when the user asks about pi itself,'

// Standalone "pi"/"Pi" only; the lookarounds spare paths and identifiers
// (`/pi/`, `pi-plugins`, `@pi`, `pi.mod`, `pi_x`, `pi:1`).
const PI_WORD = /(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])/g

export function sanitizeSystemText(text: string): string {
  return pipe(
    text.split(/\n\n+/),
    Array.filter(
      (paragraph) =>
        !paragraph.toLowerCase().includes('you are pi') &&
        !paragraph.startsWith(PI_DOCUMENTATION_HEADING) &&
        !PI_REMOVAL_ANCHORS.some((anchor) => paragraph.includes(anchor)),
    ),
    Array.join('\n\n'),
    String.replace(PI_WORD, 'Claude Code'),
    String.trim,
  )
}
