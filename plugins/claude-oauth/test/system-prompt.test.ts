import { describe, expect, test } from 'vitest'
import { sanitizeSystemText } from '../src/system-prompt'

const PREAMBLE =
  'You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.'

const docsSection = (root: string) =>
  `Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${root}/README.md
- Additional docs: ${root}/docs
- Examples: ${root}/examples (extensions, custom tools, SDK)`

const CWD = '<cwd>\n/home/user/project\n</cwd>'

describe('sanitizeSystemText', () => {
  test.each([
    ['unwrapped', (docs: string) => docs],
    ['wrapped in <docs>', (docs: string) => `<docs>\n${docs}\n</docs>`],
  ])(
    'removes the pi documentation section (%s) when the install path lacks pi-coding-agent',
    (_, frame) => {
      const docs = frame(docsSection('/nix/store/abc-pi-0.86.0/lib/pi'))
      const sanitized = sanitizeSystemText(`${PREAMBLE}\n\n${docs}\n\n${CWD}`)

      expect(sanitized).toBe(
        `${PREAMBLE.replace('inside pi,', 'inside Claude Code,')}\n\n${CWD}`,
      )
    },
  )

  test('leaves section updates without pi identity untouched', () => {
    const update = `Updated system prompt section "skills":\n\n<skills>\n- review: Review code\n</skills>`

    expect(sanitizeSystemText(update)).toBe(update)
  })
})
