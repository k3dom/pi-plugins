import type { Api, Model } from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { describe, expect, it } from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import * as Payload from '../src/payload'
import * as Helpers from './helpers'

const providerModel = (id: 'claude-opus-4-6' | 'claude-opus-5'): Model<Api> => ({
  ...getBuiltinModel('anthropic', id),
  provider: 'claude-cli',
  api: 'claude-cli',
})

describe('messages', () => {
  it('replays thinking from another model as text and keeps signed thinking from the same model', () => {
    const messages = Payload.messages(
      [
        Helpers.user('first'),
        Helpers.assistant(
          [
            {
              type: 'thinking',
              thinking: 'pondering',
              thinkingSignature: 'foreign',
            },
            { type: 'text', text: 'one' },
          ],
          { provider: 'openai', model: 'gpt-6' },
        ),
        Helpers.user('second'),
        Helpers.assistant([
          { type: 'thinking', thinking: '', thinkingSignature: 'native' },
          { type: 'text', text: 'two' },
        ]),
        Helpers.user('third'),
      ],
      Helpers.model,
      undefined,
    )

    deepStrictEqual(
      messages.map((message) => message.content),
      [
        [{ type: 'text', text: 'first' }],
        [
          { type: 'text', text: 'pondering' },
          { type: 'text', text: 'one' },
        ],
        [{ type: 'text', text: 'second' }],
        [
          { type: 'thinking', thinking: '', signature: 'native' },
          { type: 'text', text: 'two' },
        ],
        [{ type: 'text', text: 'third' }],
      ],
    )
  })

  it('answers tool calls left without a result before the next message', () => {
    const messages = Payload.messages(
      [
        Helpers.user('read both'),
        Helpers.assistant([
          { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a' } },
          { type: 'toolCall', id: 'b', name: 'read', arguments: { path: 'b' } },
        ]),
        Helpers.toolResult('a', 'contents of a'),
        Helpers.user('never mind'),
      ],
      Helpers.model,
      undefined,
    )

    deepStrictEqual(messages.at(-1)?.content, [
      { type: 'tool_result', tool_use_id: 'a', content: 'contents of a' },
      {
        type: 'tool_result',
        tool_use_id: 'b',
        content: 'No result provided',
        is_error: true,
      },
      { type: 'text', text: 'never mind' },
    ])
  })

  it('sends empty tool output without an empty text block', () => {
    const messages = Payload.messages(
      [
        Helpers.user('read it'),
        Helpers.assistant([
          { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'empty' } },
        ]),
        Helpers.toolResult('a', ''),
      ],
      Helpers.model,
      undefined,
    )

    deepStrictEqual(messages.at(-1)?.content, [
      { type: 'tool_result', tool_use_id: 'a', content: '' },
    ])
  })

  it('labels a tool result that only holds an image', () => {
    const messages = Payload.messages(
      [
        Helpers.user('screenshot'),
        Helpers.assistant([
          { type: 'toolCall', id: 'a', name: 'screenshot', arguments: {} },
        ]),
        {
          role: 'toolResult',
          toolCallId: 'a',
          toolName: 'screenshot',
          content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }],
          isError: false,
          timestamp: 0,
        },
      ],
      Helpers.model,
      undefined,
    )

    deepStrictEqual(messages.at(-1)?.content, [
      {
        type: 'tool_result',
        tool_use_id: 'a',
        content: [
          { type: 'text', text: '(see attached image)' },
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
          },
        ],
      },
    ])
  })

  it('drops failed responses', () => {
    const messages = Payload.messages(
      [
        Helpers.user('hello'),
        Helpers.assistant([{ type: 'text', text: 'partial' }], {
          stopReason: 'aborted',
        }),
        Helpers.user('hello again'),
      ],
      Helpers.model,
      undefined,
    )

    deepStrictEqual(messages, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'hello again' },
        ],
      },
    ])
  })

  it('anchors the cache on the newest message only', () => {
    const messages = Payload.messages(
      [
        Helpers.user('first'),
        Helpers.assistant([{ type: 'text', text: 'one' }]),
        Helpers.user('second'),
      ],
      Helpers.model,
      '5m',
    )

    deepStrictEqual(
      messages.map((message) => message.content),
      [
        [{ type: 'text', text: 'first' }],
        [{ type: 'text', text: 'one' }],
        [
          {
            type: 'text',
            text: 'second',
            cache_control: { type: 'ephemeral', ttl: '5m' },
          },
        ],
      ],
    )
  })
})

describe('make', () => {
  const transcript = [Helpers.user('Hi')]

  it('gives older models summarized thinking within a budget', () => {
    const { body, effort } = Payload.make(
      transcript,
      Helpers.model,
      { reasoning: 'minimal' },
      undefined,
    )

    expect(body).toMatchObject({
      max_tokens: 64000,
      thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' },
    })
    deepStrictEqual(effort, 'low')
  })

  it('gives adaptive models summarized thinking at the mapped effort', () => {
    const { body, effort } = Payload.make(
      transcript,
      providerModel('claude-opus-4-6'),
      { reasoning: 'max' },
      undefined,
    )

    deepStrictEqual(body.thinking, { type: 'adaptive', display: 'summarized' })
    deepStrictEqual(body.max_tokens, undefined)
    deepStrictEqual(effort, 'max')
  })

  it('leaves thinking to Claude Code without a level unless the model requires it', () => {
    const optional = Payload.make(transcript, Helpers.model, undefined, undefined)
    const required = Payload.make(
      transcript,
      providerModel('claude-opus-5'),
      undefined,
      undefined,
    )

    deepStrictEqual(optional.body.thinking, undefined)
    deepStrictEqual(optional.effort, undefined)
    deepStrictEqual(required.body.thinking, {
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
  })

  it('passes the output limit and tool choice through', () => {
    const { body } = Payload.make(
      transcript,
      providerModel('claude-opus-4-6'),
      { maxTokens: 500, toolChoice: 'none' },
      undefined,
    )

    expect(body).toMatchObject({ max_tokens: 500, tool_choice: { type: 'none' } })
  })
})
