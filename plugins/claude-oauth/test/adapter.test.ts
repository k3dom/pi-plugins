import type {
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  Tool,
} from '@earendil-works/pi-ai'
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat'
import { describe, expect, test } from 'vitest'
import { wrapFetchForCch } from '../src/cch'
import {
  CLAUDE_CODE_AGENT_BETAS,
  CLAUDE_CODE_BILLING_HEADER_PREFIX,
} from '../src/constants'
import { rewriteForClaudeCode } from '../src/request'
import {
  CLAUDE_PREAMBLE,
  NIX_INSTALL_ROOT,
  PI_PREAMBLE,
  cacheControls,
  piDocsSection,
} from './helpers'

// Drives the real pi adapter and SDK so pi serialization changes fail here.

const NATIVE_MODEL = 'claude-fable-5-1'
const COLLAPSED_MODEL = 'claude-opus-4-6'

const DOCS = `<docs>\n${piDocsSection(NIX_INSTALL_ROOT)}\n</docs>`
const RULES_UPDATE = '<rules>\nUse pi carefully.\n</rules>'
const SANITIZED_RULES_UPDATE = '<rules>\nUse Claude Code carefully.\n</rules>'

const tool = (name: string): Tool => ({
  name,
  description: `${name} tool`,
  parameters: { type: 'object', properties: {} },
})

const assistantTurn = (model: Model<'anthropic-messages'>): AssistantMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'hello' }],
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 2,
})

const context = (model: Model<'anthropic-messages'>): Context => ({
  messages: [
    {
      role: 'system',
      content: PI_PREAMBLE,
      sections: { docs: DOCS },
      toolsAdded: [tool('read')],
      timestamp: 0,
    },
    { role: 'user', content: 'hi', timestamp: 1 },
    assistantTurn(model),
    {
      role: 'system',
      content: '',
      sections: { rules: RULES_UPDATE },
      toolsAdded: [tool('bash')],
      timestamp: 3,
    },
    { role: 'user', content: 'again', timestamp: 4 },
  ],
})

const sseResponse = () =>
  new Response(
    [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"x","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":0}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  )

interface SentRequest {
  body: {
    system: Array<{ type: string; text: string; cache_control?: unknown }>
    messages: Array<{ role: string; content: unknown }>
    tools?: Array<{ name: string; cache_control?: unknown }>
    metadata: { user_id: string }
  }
  headers: Headers
  raw: string
}

async function send(
  modelId: string,
  cacheRetention?: CacheRetention,
): Promise<SentRequest> {
  const model = getModel(
    'anthropic',
    modelId as never,
  ) as Model<'anthropic-messages'>
  const calls: RequestInit[] = []
  const recording: typeof fetch = async (_input, init) => {
    calls.push(init ?? {})
    return sseResponse()
  }
  const message = await streamSimple(model, context(model), {
    apiKey: 'sk-ant-oat01-test',
    fetch: wrapFetchForCch(recording, {
      'anthropic-beta': CLAUDE_CODE_AGENT_BETAS.join(','),
    }),
    onPayload: (payload) => rewriteForClaudeCode(payload),
    maxRetries: 0,
    reasoning: 'medium',
    cacheRetention,
  }).result()

  expect(message.stopReason).toBe('stop')
  expect(calls).toHaveLength(1)
  const init = calls[0]!
  const raw = Buffer.from(init.body as Uint8Array).toString()
  return { body: JSON.parse(raw), headers: new Headers(init.headers), raw }
}

describe('through the pi anthropic adapter', () => {
  test.each([NATIVE_MODEL, COLLAPSED_MODEL])(
    '%s: replaces pi identity and attests the request',
    async (modelId) => {
      const { body, headers, raw } = await send(modelId)

      expect(body.system[0]?.text).toMatch(
        new RegExp(`^${CLAUDE_CODE_BILLING_HEADER_PREFIX} .*cch=[0-9a-f]{5};`),
      )
      expect(raw).not.toContain('Claude Code, Anthropic')
      expect(raw).not.toContain('inside pi,')
      expect(raw).not.toContain('Pi documentation')
      expect(raw).not.toContain('Use pi carefully')
      expect(raw).toContain('Use Claude Code carefully')

      const betas = headers.get('anthropic-beta')?.split(',') ?? []
      expect(betas).toEqual(expect.arrayContaining([...CLAUDE_CODE_AGENT_BETAS]))
      expect(betas).toContain('oauth-2025-04-20')
      expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-test')

      const identity = JSON.parse(body.metadata.user_id) as Record<string, string>
      expect(identity['session_id']).toBeTruthy()
      expect(headers.get('x-claude-code-session-id')).toBe(identity['session_id'])
    },
  )

  test('native transcripts keep tool changes inside sanitized system messages', async () => {
    const { body } = await send(NATIVE_MODEL)

    const updates = body.messages.filter(
      (message) =>
        message.role === 'system' &&
        Array.isArray(message.content) &&
        message.content.length > 0,
    )
    expect(updates).toHaveLength(1)
    expect(updates[0]?.content).toEqual([
      {
        type: 'text',
        text: `Updated system prompt section "rules":\n\n${SANITIZED_RULES_UPDATE}`,
      },
      {
        type: 'tool_addition',
        tool: { type: 'tool_reference', name: 'Bash' },
        cache_control: { type: 'ephemeral' },
      },
    ])
    expect(body.tools?.map((declared) => declared.name)).toContain('Bash')
  })

  test('collapsed transcripts carry the update in the leading prompt', async () => {
    const { body } = await send(COLLAPSED_MODEL)

    expect(body.messages.some((message) => message.role === 'system')).toBe(false)
    expect(body.system.at(-1)?.text).toBe(
      `${CLAUDE_PREAMBLE}\n\n${SANITIZED_RULES_UPDATE}`,
    )
  })

  test.each<[CacheRetention | undefined, unknown]>([
    [undefined, { type: 'ephemeral' }],
    ['short', { type: 'ephemeral' }],
    ['long', { type: 'ephemeral', ttl: '1h' }],
  ])('keeps the %s retention markers pi emitted', async (retention, marker) => {
    const { body } = await send(NATIVE_MODEL, retention)

    const markers = cacheControls(body)
    expect(markers.length).toBeGreaterThan(0)
    for (const found of markers) {
      expect(found).toEqual(marker)
    }
  })

  test('adds no cache markers when pi requested none', async () => {
    const { body } = await send(NATIVE_MODEL, 'none')

    expect(cacheControls(body)).toHaveLength(0)
  })
})
