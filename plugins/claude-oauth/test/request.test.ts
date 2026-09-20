import { describe, expect, test } from 'vitest'
import { PI_ANTHROPIC_OAUTH_SENTINEL } from '../src/constants'
import { rewriteForClaudeCode } from '../src/request'

const oauthPayload = (cacheControl?: Record<string, unknown>) => ({
  model: 'claude-fable-5-1',
  system: [
    {
      type: 'text',
      text: PI_ANTHROPIC_OAUTH_SENTINEL,
      ...(cacheControl && { cache_control: cacheControl }),
    },
    {
      type: 'text',
      text: 'Be helpful.',
      ...(cacheControl && { cache_control: cacheControl }),
    },
  ],
  tools: [
    {
      name: 'read',
      input_schema: { type: 'object' },
      ...(cacheControl && { cache_control: cacheControl }),
    },
  ],
  messages: [
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Hello',
          ...(cacheControl && { cache_control: cacheControl }),
        },
      ],
    },
  ],
})

const cacheControls = (payload: unknown): unknown[] => {
  const found: unknown[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit)
    } else if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        if (key === 'cache_control') {
          found.push(value)
        } else {
          visit(value)
        }
      }
    }
  }
  visit(payload)
  return found
}

describe('rewriteForClaudeCode', () => {
  test.each([
    ['short retention', { type: 'ephemeral' }],
    ['long retention', { type: 'ephemeral', ttl: '1h' }],
  ])('preserves cache markers pi emitted for %s', (_, cacheControl) => {
    const payload = oauthPayload(cacheControl)
    const rewritten = rewriteForClaudeCode(payload)

    expect(rewritten).toBe(payload)
    const markers = cacheControls(rewritten)
    expect(markers).toHaveLength(4)
    for (const marker of markers) {
      expect(marker).toEqual(cacheControl)
    }
  })

  test('does not add cache markers when pi emitted none', () => {
    const rewritten = rewriteForClaudeCode(oauthPayload())

    expect(cacheControls(rewritten)).toHaveLength(0)
  })

  test('sanitizes native mid-conversation system messages', () => {
    const toolChanges = [
      { type: 'tool_removal', tool: { type: 'tool_reference', name: 'Grep' } },
      { type: 'tool_addition', tool: { type: 'tool_reference', name: 'Bash' } },
    ]
    const effortOnly = {
      role: 'system',
      content: [],
      output_config: { effort: 'high' },
    }
    const userTurn = { role: 'user', content: 'You are pi, right?' }
    const payload = {
      ...oauthPayload(),
      messages: [
        userTurn,
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text: 'Updated system prompt section "rules":\n\n<rules>\nUse pi carefully.\n</rules>',
            },
            ...toolChanges,
          ],
        },
        effortOnly,
        {
          role: 'system',
          content: [{ type: 'text', text: 'You are pi.' }],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'I am pi.' }] },
      ],
    }

    const rewritten = rewriteForClaudeCode(payload)

    expect(rewritten?.messages).toEqual([
      userTurn,
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: 'Updated system prompt section "rules":\n\n<rules>\nUse Claude Code carefully.\n</rules>',
          },
          ...toolChanges,
        ],
      },
      effortOnly,
      { role: 'assistant', content: [{ type: 'text', text: 'I am pi.' }] },
    ])
  })

  test('leaves non-OAuth payloads untouched', () => {
    const payload = {
      system: [
        { type: 'text', text: 'Be helpful.', cache_control: { type: 'ephemeral' } },
      ],
      messages: [],
    }

    expect(rewriteForClaudeCode(payload)).toBeUndefined()
    expect(payload.system[0]?.cache_control).toEqual({ type: 'ephemeral' })
  })
})
