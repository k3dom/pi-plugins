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
import { buildProviderHeaders, rewriteForClaudeCode } from '../src/request'
import {
  CLAUDE_PREAMBLE,
  NIX_INSTALL_ROOT,
  PI_PREAMBLE,
  cacheControls,
  piDocsSection,
} from './helpers'

const NATIVE_MODEL = getModel('anthropic', 'claude-fable-5-1')
const COLLAPSED_MODEL = getModel('anthropic', 'claude-opus-4-6')

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
      sections: { docs: DOCS, rules: RULES_UPDATE },
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
    model: string
    max_tokens: number
    thinking?: unknown
    output_config?: unknown
    context_management?: unknown
    diagnostics?: unknown
    fallbacks?: unknown
    system: Array<{ type: string; text: string; cache_control?: unknown }>
    messages: Array<{ role: string; content: unknown; output_config?: unknown }>
    tools?: Array<{ name: string; cache_control?: unknown }>
    metadata: { user_id: string }
  }
  headers: Headers
  raw: string
  originalCacheControls: unknown[]
}

async function send(
  model: Model<'anthropic-messages'>,
  cacheRetention?: CacheRetention,
  apiKey = 'sk-ant-oat01-test',
): Promise<SentRequest> {
  const calls: RequestInit[] = []
  let originalCacheControls: unknown[] = []
  const recording: typeof fetch = async (_input, init) => {
    calls.push(init ?? {})
    return sseResponse()
  }
  const message = await streamSimple(model, context(model), {
    apiKey,
    fetch: wrapFetchForCch(recording, buildProviderHeaders()),
    onPayload: (payload) => {
      originalCacheControls = structuredClone(cacheControls(payload))
      return rewriteForClaudeCode(payload)
    },
    maxRetries: 0,
    reasoning: 'medium',
    cacheRetention,
    env: { PI_CACHE_RETENTION: 'short' },
  }).result()

  expect(message.stopReason).toBe('stop')
  expect(calls).toHaveLength(1)
  const init = calls[0]!
  const raw = Buffer.from(init.body as Uint8Array).toString()
  return {
    body: JSON.parse(raw),
    headers: new Headers(init.headers),
    raw,
    originalCacheControls,
  }
}

describe('through the pi anthropic adapter', () => {
  test('matches the captured Claude Code 2.1.280 identity and headers', async () => {
    const { body, headers } = await send(NATIVE_MODEL)

    expect(body.system[0]?.text).toMatch(
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.d7b; cc_entrypoint=local-agent; cch=[0-9a-f]{5}; cc_prompt_id=[0-9a-f-]{36}; cc_turn_origin=sdk;$/,
    )
    expect(body.system.slice(1).map((block) => block.text)).toEqual([
      "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      CLAUDE_PREAMBLE,
    ])
    expect(headers.get('user-agent')).toBe(
      'claude-cli/2.1.280 (external, local-agent, agent-sdk/0.3.280)',
    )
    expect(headers.get('x-stainless-package-version')).toBe('0.112.1')
    expect(headers.get('x-stainless-runtime-version')).toBe('v26.3.0')
    expect(headers.get('x-stainless-timeout')).toBe('600')
    expect(headers.get('authorization')).toBe('Bearer sk-ant-oat01-test')

    const identity = JSON.parse(body.metadata.user_id) as Record<string, string>
    expect(identity['session_id']).toMatch(/^[0-9a-f-]{36}$/)
    expect(headers.get('x-claude-code-session-id')).toBe(identity['session_id'])
  })

  test('preserves native prompt updates, tools, thinking and model-specific options', async () => {
    const { body, headers } = await send({
      ...NATIVE_MODEL,
      maxTokens: 8192,
      compat: {
        ...NATIVE_MODEL.compat,
        allowedFallbackModels: [
          {
            provider: 'anthropic',
            model: 'claude-opus-5',
            cost: NATIVE_MODEL.cost,
          },
        ],
      },
    })

    expect(body.model).toBe('claude-fable-5-1')
    expect(body.max_tokens).toBe(8192)
    expect(body.thinking).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
    expect(body.output_config).toEqual({ effort: 'high' })
    expect(body.messages).toContainEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'medium' },
    })
    expect(body.context_management).toEqual({
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    })
    expect(body.diagnostics).toEqual({ previous_message_id: null })
    expect(body.fallbacks).toEqual([{ model: 'claude-opus-5' }])
    expect(headers.get('anthropic-beta')?.split(',')).toEqual(
      expect.arrayContaining([
        'oauth-2025-04-20',
        'per-turn-control-2026-07-01',
        'mid-conversation-tool-changes-2026-07-01',
        'mid-conversation-system-clear-at-2026-08-21',
        'thinking-binding-controls-2026-08-01',
        'mid-conversation-output-config-2026-07-01',
        'server-side-fallback-2026-07-01',
      ]),
    )
    expect(headers.get('anthropic-beta')).not.toContain(
      'server-side-fallback-2026-06-01',
    )
    expect(
      body.messages.filter(
        (message) =>
          message.role === 'system' &&
          Array.isArray(message.content) &&
          message.content.length > 0,
      ),
    ).toEqual([
      {
        role: 'system',
        content: [
          {
            type: 'text',
            text: `Updated system prompt section "rules":\n\n${SANITIZED_RULES_UPDATE}`,
          },
          {
            type: 'tool_addition',
            tool: { type: 'tool_reference', name: 'Bash' },
            cache_control: { type: 'ephemeral' },
          },
        ],
      },
    ])
    expect(body.tools?.map((declared) => declared.name)).toContain('Bash')
  })

  test('leaves API-key requests without OAuth identity or header overrides', async () => {
    const { body, headers, raw } = await send(
      NATIVE_MODEL,
      'short',
      'sk-ant-api-test',
    )

    expect(body.system[0]?.text).toContain(PI_PREAMBLE)
    expect(raw).toContain('Pi documentation')
    expect(raw).not.toContain('x-anthropic-billing-header')
    expect(headers.get('x-api-key')).toBe('sk-ant-api-test')
    expect(headers.get('user-agent')).not.toContain('claude-cli/')
    expect(headers.get('x-claude-code-session-id')).toBeNull()
  })

  test('collapsed transcripts carry the update in the leading prompt', async () => {
    const { body } = await send(COLLAPSED_MODEL)

    expect(body.messages.some((message) => message.role === 'system')).toBe(false)
    expect(body.system.at(-1)?.text).toBe(
      `${CLAUDE_PREAMBLE}\n\n${SANITIZED_RULES_UPDATE}`,
    )
  })

  test.each<CacheRetention>(['short', 'long', 'none'])(
    'preserves exactly the cache markers pi emits for %s retention',
    async (retention) => {
      const { body, originalCacheControls } = await send(NATIVE_MODEL, retention)

      if (retention === 'none') {
        expect(originalCacheControls).toHaveLength(0)
      } else {
        expect(originalCacheControls.length).toBeGreaterThan(0)
      }
      expect(cacheControls(body)).toEqual(originalCacheControls)
    },
  )
})
