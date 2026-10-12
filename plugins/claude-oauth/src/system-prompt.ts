import { Array, pipe, String } from 'effect'

export function sanitize(text: string): string {
  return pipe(
    text,
    String.replace(
      /(?:Updated system prompt section "docs":\n\n)?<docs>\nPi documentation \(read only when the user asks about pi itself,[\s\S]*?<\/docs>/g,
      '',
    ),
    String.split(/\n\n+/),
    Array.filter(
      (paragraph) =>
        !pipe(paragraph, String.toLowerCase, String.includes('you are pi')) &&
        !Array.some(
          [
            'Pi documentation (read only when the user asks about pi itself,',
            'pi-coding-agent',
            '@earendil-works/pi-coding-agent',
            'badlogic/pi-mono',
          ],
          (anchor) => String.includes(anchor)(paragraph),
        ),
    ),
    Array.join('\n\n'),
    // Standalone "pi"/"Pi" only. The lookarounds spare paths and identifiers
    // (`/pi/`, `pi-plugins`, `@pi`, `pi.mod`, `pi_x`, `pi:1`).
    String.replace(/(?<![/\\.@:_-])\b[Pp]i\b(?![/\\.@:_-])/g, 'Claude Code'),
    String.trim,
  )
}
