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

  test('preserves project docs and identifiers while replacing standalone pi', () => {
    const docs =
      '<docs>\nUse pi with /pi/bin, @pi/tool, pi-plugins, pi.mod, pi_x and pi:1.\n</docs>'

    expect(sanitizeSystemText(docs)).toBe(
      '<docs>\nUse Claude Code with /pi/bin, @pi/tool, pi-plugins, pi.mod, pi_x and pi:1.\n</docs>',
    )
  })
})
