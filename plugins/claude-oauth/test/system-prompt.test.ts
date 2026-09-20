import { describe, expect, test } from 'vitest'
import { sanitizeSystemText } from '../src/system-prompt'
import {
  CLAUDE_PREAMBLE,
  NIX_INSTALL_ROOT,
  PI_PREAMBLE,
  piDocsSection,
} from './helpers'

const CWD = '<cwd>\n/home/user/project\n</cwd>'

describe('sanitizeSystemText', () => {
  test.each([
    ['unwrapped', (docs: string) => docs],
    ['wrapped in <docs>', (docs: string) => `<docs>\n${docs}\n</docs>`],
  ])(
    'removes the pi documentation section (%s) when the install path lacks pi-coding-agent',
    (_, frame) => {
      const docs = frame(piDocsSection(NIX_INSTALL_ROOT))
      const sanitized = sanitizeSystemText(`${PI_PREAMBLE}\n\n${docs}\n\n${CWD}`)

      expect(sanitized).toBe(`${CLAUDE_PREAMBLE}\n\n${CWD}`)
    },
  )

  test('leaves section updates without pi identity untouched', () => {
    const update = `Updated system prompt section "skills":\n\n<skills>\n- review: Review code\n</skills>`

    expect(sanitizeSystemText(update)).toBe(update)
  })
})
