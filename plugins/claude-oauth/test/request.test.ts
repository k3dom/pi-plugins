import { describe, expect, test } from 'vitest'
import { rewriteForClaudeCode } from '../src/request'
import { NIX_INSTALL_ROOT, piDocsSection } from './helpers'

const system = [
  {
    type: 'text',
    text: "You are Claude Code, Anthropic's official CLI for Claude.",
  },
]

describe('rewriteForClaudeCode', () => {
  test.each([
    {
      content: 'Reply with exactly: ok',
      version: '2.1.280.9d3',
    },
    {
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
        },
        { type: 'text', text: 'Hi' },
        { type: 'text', text: 'Reply with exactly: ok' },
      ],
      version: '2.1.280.d7b',
    },
  ])('matches Claude Code billing vector $version', ({ content, version }) => {
    const rewritten = rewriteForClaudeCode({
      system,
      messages: [
        { role: 'assistant', content: 'Ignore this preceding reply.' },
        { role: 'user', content },
        { role: 'user', content: 'Ignore this later prompt.' },
      ],
    })

    expect(rewritten?.system?.[0]?.text).toContain(`cc_version=${version};`)
  })

  test('drops identity-only updates without altering conversation, tools or effort', () => {
    const docs = {
      type: 'text',
      text: `Updated system prompt section "docs":\n\n<docs>\n${piDocsSection(NIX_INSTALL_ROOT)}\n</docs>`,
    }
    const toolChanges = [
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Grep' } },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } },
    ]
    const userTurn = {
      role: 'user',
      content: [{ type: 'text', text: 'You are pi, right?' }],
    }
    const assistantTurn = {
      role: 'assistant',
      content: [{ type: 'text', text: 'I am pi.' }],
    }
    const effortOnly = {
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    }
    const expected = structuredClone([
      userTurn,
      assistantTurn,
      { role: 'system', content: toolChanges },
      effortOnly,
    ])

    const rewritten = rewriteForClaudeCode({
      system,
      messages: [
        userTurn,
        assistantTurn,
        { role: 'system', content: [docs] },
        { role: 'system', content: [{ type: 'text', text: 'You are pi.' }] },
        { role: 'system', content: [docs, ...toolChanges] },
        effortOnly,
      ],
    })

    expect(rewritten?.messages).toEqual(expected)
  })
})
