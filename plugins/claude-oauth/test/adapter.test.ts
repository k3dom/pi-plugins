import type {
  AssistantMessage,
  CacheRetention,
  Context,
  Model,
  Tool,
} from '@earendil-works/pi-ai'
import { getModel, streamSimple } from '@earendil-works/pi-ai/compat'
import { assert, describe, it } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { Schema } from 'effect'
import * as Cch from '../src/cch'
import * as ClaudeCode from '../src/claude-code'
import * as Helpers from './helpers'

const NATIVE_MODEL = getModel('anthropic', 'claude-fable-5-1')
const COLLAPSED_MODEL = getModel('anthropic', 'claude-opus-4-6')

const DOCS = `<docs>\n${Helpers.piDocsSection(Helpers.NIX_INSTALL_ROOT)}\n</docs>`
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
      content: Helpers.PI_PREAMBLE,
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

async function send(
  model: Model<'anthropic-messages'>,
  cacheRetention?: CacheRetention,
  apiKey = 'sk-ant-oat01-test',
) {
  const calls: RequestInit[] = []
  let originalCacheControls: unknown[] = []
  const recording: typeof fetch = async (_input, init) => {
    calls.push(init ?? {})
    return sseResponse()
  }
  const message = await streamSimple(model, context(model), {
    apiKey,
    fetch: Cch.wrapFetch(recording, ClaudeCode.headers()),
    onPayload: (payload) => {
      originalCacheControls = structuredClone(Helpers.cacheControls(payload))
      return ClaudeCode.rewrite(payload)
    },
    maxRetries: 0,
    reasoning: 'medium',
    cacheRetention,
    env: { PI_CACHE_RETENTION: 'short' },
  }).result()

  assert.strictEqual(message.stopReason, 'stop')
  assert.lengthOf(calls, 1)
  const init = calls[0]!
  const raw = Buffer.from(init.body as Uint8Array).toString()
  const body: {
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
  } = JSON.parse(raw)
  return {
    body,
    headers: new Headers(init.headers),
    raw,
    originalCacheControls,
  }
}

describe('through the pi anthropic adapter', () => {
  it('matches the captured Claude Code 2.1.280 identity and headers', async () => {
    const { body, headers } = await send(NATIVE_MODEL)

    assert.match(
      body.system[0]?.text ?? '',
      /^x-anthropic-billing-header: cc_version=2\.1\.280\.d7b; cc_entrypoint=local-agent; cch=[0-9a-f]{5}; cc_prompt_id=[0-9a-f-]{36}; cc_turn_origin=sdk;$/,
    )
    deepStrictEqual(
      body.system.slice(1).map((block) => block.text),
      [
        "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        Helpers.CLAUDE_PREAMBLE,
      ],
    )
    assert.strictEqual(
      headers.get('user-agent'),
      'claude-cli/2.1.280 (external, local-agent, agent-sdk/0.3.280)',
    )
    assert.strictEqual(headers.get('x-stainless-package-version'), '0.112.1')
    assert.strictEqual(headers.get('x-stainless-runtime-version'), 'v26.3.0')
    assert.strictEqual(headers.get('x-stainless-timeout'), '600')
    assert.strictEqual(headers.get('authorization'), 'Bearer sk-ant-oat01-test')

    const identity = Schema.decodeUnknownSync(
      Schema.fromJsonString(Schema.Struct({ session_id: Schema.String })),
    )(body.metadata.user_id)
    assert.match(identity.session_id, /^[0-9a-f-]{36}$/)
    assert.strictEqual(headers.get('x-claude-code-session-id'), identity.session_id)
  })

  it('preserves native prompt updates, tools, thinking and model-specific options', async () => {
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

    assert.strictEqual(body.model, 'claude-fable-5-1')
    assert.strictEqual(body.max_tokens, 8192)
    deepStrictEqual(body.thinking, {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
    deepStrictEqual(body.output_config, { effort: 'high' })
    assert.deepInclude(body.messages, {
      role: 'system',
      content: [],
      output_config: { effort: 'medium' },
    })
    deepStrictEqual(body.context_management, {
      edits: [{ type: 'clear_thinking_20251015', keep: 'all' }],
    })
    deepStrictEqual(body.diagnostics, { previous_message_id: null })
    deepStrictEqual(body.fallbacks, [{ model: 'claude-opus-5' }])
    const betas = headers.get('anthropic-beta') ?? ''
    assert.includeMembers(betas.split(','), [
      'oauth-2025-04-20',
      'per-turn-control-2026-07-01',
      'mid-conversation-tool-changes-2026-07-01',
      'mid-conversation-system-clear-at-2026-08-21',
      'thinking-binding-controls-2026-08-01',
      'mid-conversation-output-config-2026-07-01',
      'server-side-fallback-2026-07-01',
    ])
    assert.notInclude(betas, 'server-side-fallback-2026-06-01')
    deepStrictEqual(
      body.messages.filter(
        (message) =>
          message.role === 'system' &&
          Array.isArray(message.content) &&
          message.content.length > 0,
      ),
      [
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
      ],
    )
    assert.include(body.tools?.map((declared) => declared.name) ?? [], 'Bash')
  })

  it('leaves API-key requests without OAuth identity or header overrides', async () => {
    const { body, headers, raw } = await send(
      NATIVE_MODEL,
      'short',
      'sk-ant-api-test',
    )

    assert.include(body.system[0]?.text ?? '', Helpers.PI_PREAMBLE)
    assert.include(raw, 'Pi documentation')
    assert.notInclude(raw, 'x-anthropic-billing-header')
    assert.strictEqual(headers.get('x-api-key'), 'sk-ant-api-test')
    const userAgent = headers.get('user-agent')
    assert.isNotNull(userAgent)
    assert.notInclude(userAgent, 'claude-cli/')
    assert.isNull(headers.get('x-claude-code-session-id'))
  })

  it('collapsed transcripts carry the update in the leading prompt', async () => {
    const { body } = await send(COLLAPSED_MODEL)

    assert.isFalse(body.messages.some((message) => message.role === 'system'))
    assert.strictEqual(
      body.system.at(-1)?.text,
      `${Helpers.CLAUDE_PREAMBLE}\n\n${SANITIZED_RULES_UPDATE}`,
    )
  })

  it.each<CacheRetention>(['short', 'long', 'none'])(
    'preserves exactly the cache markers pi emits for %s retention',
    async (retention) => {
      const { body, originalCacheControls } = await send(NATIVE_MODEL, retention)

      if (retention === 'none') {
        assert.isEmpty(originalCacheControls)
      } else {
        assert.isNotEmpty(originalCacheControls)
      }
      deepStrictEqual(Helpers.cacheControls(body), originalCacheControls)
    },
  )
})
