import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeContext,
  type Api,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest'
import * as Cli from '../src/cli'
import { assistant, model, toolResult, user } from './helpers'

interface Received {
  args: Array<string>
  env: Record<string, string | undefined>
  systemPrompt: string
  settings: { env: { CLAUDE_CODE_EXTRA_BODY: string } }
  input: Array<unknown>
}

interface Reply {
  lines: Array<unknown>
  exitCode?: number
}

const adaptiveModel: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-opus-4-6'),
  provider: 'claude-code',
  api: 'claude-code',
}

const managedEffortModel: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-opus-5'),
  provider: 'claude-code',
  api: 'claude-code',
}

let dir: string
let log: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-code-test-'))
  log = join(dir, 'received.json')
  const script = fileURLToPath(new URL('fake-claude.mjs', import.meta.url))
  await writeFile(join(dir, 'claude'), `#!/bin/sh\nexec node '${script}' "$@"\n`, {
    mode: 0o755,
  })
  process.env['PATH'] = `${dir}:${process.env['PATH']}`
  process.env['FAKE_CLAUDE_LOG'] = log
})

beforeEach(() => rm(`${log}.count`, { force: true }))

afterAll(() => rm(dir, { recursive: true, force: true }))

const event = (payload: object) => ({
  type: 'stream_event',
  event: payload,
})

const messageStart = (id: string) =>
  event({
    type: 'message_start',
    message: {
      id,
      model: model.id,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    },
  })

const textReply = (id: string, text: string): Reply => ({
  lines: [
    messageStart(id),
    event({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }),
    event({
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    }),
    event({ type: 'content_block_stop', index: 0 }),
    event({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 20 },
    }),
    event({ type: 'message_stop' }),
  ],
})

const run = async (
  replies: Array<Reply>,
  context: Context,
  options?: SimpleStreamOptions,
  target: Model<Api> = model,
) => {
  process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify(replies)
  const stream = Cli.stream(target, normalizeContext(context), options)
  const events: Array<string> = []
  for await (const next of stream) {
    events.push(next.type)
  }
  const received = JSON.parse(await readFile(log, 'utf8')) as Received
  return {
    message: await stream.result(),
    events,
    received,
    body: JSON.parse(received.settings.env.CLAUDE_CODE_EXTRA_BODY) as Record<
      string,
      unknown
    >,
  }
}

describe('stream', () => {
  test('streams a text reply with its usage and cost', async () => {
    const { message, events } = await run([textReply('msg_1', 'Hello there')], {
      messages: [user('Hi')],
    })

    expect(message).toMatchObject({
      stopReason: 'stop',
      responseId: 'msg_1',
      content: [{ type: 'text', text: 'Hello there' }],
      usage: {
        input: 10,
        output: 20,
        cacheRead: 30,
        cacheWrite: 40,
        totalTokens: 100,
      },
    })
    // Haiku 4.5 at $1 input, $5 output, $0.10 cache read and $1.25 cache write per MTok.
    expect(message.usage.cost.total).toBeCloseTo(0.000163, 9)
    expect(events).toEqual(['start', 'text_start', 'text_delta', 'text_end', 'done'])
  })

  test('returns the tool call and ignores what Claude Code does after the first message', async () => {
    const { message } = await run(
      [
        {
          lines: [
            messageStart('msg_1'),
            event({
              type: 'content_block_start',
              index: 0,
              content_block: {
                type: 'tool_use',
                id: 'toolu_1',
                name: 'read',
                input: {},
              },
            }),
            event({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '{"path":' },
            }),
            event({
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: '"a.txt"}' },
            }),
            event({ type: 'content_block_stop', index: 0 }),
            event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
            event({ type: 'message_stop' }),
            ...textReply('msg_2', 'I could not run that tool.').lines,
          ],
        },
      ],
      { messages: [user('Read a.txt')] },
    )

    expect(message).toMatchObject({ stopReason: 'toolUse', responseId: 'msg_1' })
    expect(message.content).toEqual([
      {
        type: 'toolCall',
        id: 'toolu_1',
        name: 'read',
        arguments: { path: 'a.txt' },
      },
    ])
  })

  test("sends pi's conversation and tools in place of Claude Code's own", async () => {
    const { received, body } = await run(
      [textReply('msg_1', 'Done')],
      {
        systemPrompt: 'Be terse.',
        tools: [
          {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
        messages: [
          user('Read a.txt'),
          assistant([
            {
              type: 'toolCall',
              id: 'call|1',
              name: 'read',
              arguments: { path: 'a.txt' },
            },
          ]),
          toolResult('call|1', 'contents'),
        ],
      },
      { cacheRetention: 'long' },
    )

    expect(received.systemPrompt).toBe('Be terse.')
    expect(body).toEqual({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_1',
              name: 'read',
              input: { path: 'a.txt' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_1',
              content: [{ type: 'text', text: 'contents' }],
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
      ],
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          input_schema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    })
    expect(received.env['CLAUDE_CODE_PROMPT_CACHE_TTL']).toBe('1h')
    // Claude Code fingerprints the first user message in its billing header.
    expect(received.input).toEqual([
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      },
    ])
  })

  test('keeps an API key in the environment away from Claude Code', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
    try {
      const { received } = await run([textReply('msg_1', 'Hi')], {
        messages: [user('Hi')],
      })
      expect(received.env['ANTHROPIC_API_KEY']).toBeUndefined()
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  test('gives older models summarized thinking within a budget', async () => {
    const { body, received } = await run(
      [textReply('msg_1', 'Hi')],
      { messages: [user('Hi')] },
      { reasoning: 'minimal' },
    )

    expect(body).toMatchObject({
      max_tokens: 64000,
      thinking: { type: 'enabled', budget_tokens: 1024, display: 'summarized' },
    })
    expect(received.args.join(' ')).toContain('--effort low')
  })

  test('gives adaptive models summarized thinking at the mapped effort', async () => {
    const { body, received } = await run(
      [textReply('msg_1', 'Hi')],
      { messages: [user('Hi')] },
      { reasoning: 'max' },
      adaptiveModel,
    )

    expect(body['thinking']).toEqual({ type: 'adaptive', display: 'summarized' })
    expect(body['max_tokens']).toBeUndefined()
    expect(received.args.join(' ')).toContain('--effort max')
  })

  test('turns thinking off without a level unless the model requires it', async () => {
    const off = await run([textReply('msg_1', 'Hi')], { messages: [user('Hi')] })
    const required = await run(
      [textReply('msg_2', 'Hi')],
      { messages: [user('Hi')] },
      undefined,
      managedEffortModel,
    )

    expect(off.received.env['CLAUDE_CODE_DISABLE_THINKING']).toBe('1')
    expect(off.body['thinking']).toBeUndefined()
    expect(required.received.env['CLAUDE_CODE_DISABLE_THINKING']).toBeUndefined()
    expect(required.body['thinking']).toEqual({
      type: 'adaptive',
      display: 'summarized',
      block_binding: { prefix_mismatch_behavior: 'drop_block' },
    })
  })

  test('passes the output limit and tool choice through', async () => {
    const { body } = await run(
      [textReply('msg_1', 'Hi')],
      { messages: [user('Hi')] },
      { maxTokens: 500, toolChoice: 'none' },
      adaptiveModel,
    )

    expect(body).toMatchObject({ max_tokens: 500, tool_choice: { type: 'none' } })
  })

  test("reports Claude Code's error when no response arrives", async () => {
    const { message } = await run(
      [
        {
          lines: [
            {
              type: 'result',
              subtype: 'success',
              is_error: true,
              num_turns: 1,
              result: 'API Error: 529 Overloaded',
            },
          ],
          exitCode: 1,
        },
      ],
      { messages: [user('Hi')] },
    )

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage: 'API Error: 529 Overloaded',
    })
  })

  test('retries while another Claude Code process refreshes the login', async () => {
    const { message } = await run(
      [
        {
          lines: [
            {
              type: 'result',
              subtype: 'success',
              is_error: true,
              num_turns: 1,
              result:
                'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh)',
            },
          ],
          exitCode: 1,
        },
        textReply('msg_1', 'Hello'),
      ],
      { messages: [user('Hi')] },
    )

    expect(message).toMatchObject({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Hello' }],
    })
  })

  test('stops a running request when aborted', async () => {
    process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify([
      { lines: textReply('msg_1', 'Hel').lines.slice(0, 3) },
    ])
    const controller = new AbortController()
    const stream = Cli.stream(model, normalizeContext({ messages: [user('Hi')] }), {
      signal: controller.signal,
    })
    for await (const next of stream) {
      if (next.type === 'text_delta') {
        controller.abort()
      }
    }

    expect(await stream.result()).toMatchObject({
      stopReason: 'aborted',
      content: [{ type: 'text', text: 'Hel' }],
    })
  })
})
