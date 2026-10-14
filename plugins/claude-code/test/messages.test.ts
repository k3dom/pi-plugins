import { describe, expect, test } from 'vitest'
import * as Messages from '../src/messages'
import { assistant, model, toolResult, user } from './helpers'

describe('fromTranscript', () => {
  test('replays thinking from another model as text and keeps signed thinking from the same model', () => {
    const messages = Messages.fromTranscript(
      [
        user('first'),
        assistant(
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
        user('second'),
        assistant([
          { type: 'thinking', thinking: '', thinkingSignature: 'native' },
          { type: 'text', text: 'two' },
        ]),
        user('third'),
      ],
      model,
      undefined,
    )

    expect(messages.map((message) => message.content)).toEqual([
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
    ])
  })

  test('answers tool calls left without a result before the next message', () => {
    const messages = Messages.fromTranscript(
      [
        user('read both'),
        assistant([
          { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a' } },
          { type: 'toolCall', id: 'b', name: 'read', arguments: { path: 'b' } },
        ]),
        toolResult('a', 'contents of a'),
        user('never mind'),
      ],
      model,
      undefined,
    )

    expect(messages.at(-1)?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'a',
        content: [{ type: 'text', text: 'contents of a' }],
      },
      {
        type: 'tool_result',
        tool_use_id: 'b',
        content: [{ type: 'text', text: 'No result provided' }],
        is_error: true,
      },
      { type: 'text', text: 'never mind' },
    ])
  })

  test('drops failed responses', () => {
    const messages = Messages.fromTranscript(
      [
        user('hello'),
        assistant([{ type: 'text', text: 'partial' }], { stopReason: 'aborted' }),
        user('hello again'),
      ],
      model,
      undefined,
    )

    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'text', text: 'hello again' },
        ],
      },
    ])
  })

  test('anchors the cache on the newest message only', () => {
    const messages = Messages.fromTranscript(
      [user('first'), assistant([{ type: 'text', text: 'one' }]), user('second')],
      model,
      '5m',
    )

    expect(messages.map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'first' }],
      [{ type: 'text', text: 'one' }],
      [
        {
          type: 'text',
          text: 'second',
          cache_control: { type: 'ephemeral', ttl: '5m' },
        },
      ],
    ])
  })
})
