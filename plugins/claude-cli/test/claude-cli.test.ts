import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  normalizeContext,
  type Context,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import {
  afterAll,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import * as ClaudeCli from '../src/claude-cli'
import * as Helpers from './helpers'

type Reply = { lines: Array<unknown>; exitCode?: number; settingsError?: string }

let dir: string
let log: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-cli-test-'))
  log = join(dir, 'received.json')
  const script = fileURLToPath(new URL('fake-claude.mjs', import.meta.url))
  await writeFile(join(dir, 'claude'), `#!/bin/sh\nexec node '${script}' "$@"\n`, {
    mode: 0o755,
  })
  process.env['PATH'] = `${dir}:${process.env['PATH']}`
  process.env['FAKE_CLAUDE_LOG'] = log
})

beforeEach(async () => {
  await rm(log, { force: true })
  await rm(`${log}.count`, { force: true })
})

afterAll(() => rm(dir, { recursive: true, force: true }))

const event = (payload: object) => ({ type: 'stream_event', event: payload })

const messageStart = (id: string) =>
  event({
    type: 'message_start',
    message: {
      id,
      model: Helpers.model.id,
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        cache_read_input_tokens: 30,
        cache_creation_input_tokens: 40,
      },
    },
  })

const reply = (id: string, text: string, stopReason = 'end_turn'): Reply => ({
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
      delta: { stop_reason: stopReason },
      usage: { output_tokens: 20 },
    }),
    event({ type: 'message_stop' }),
  ],
})

const failure = (result: string): Reply => ({
  lines: [
    { type: 'result', subtype: 'success', is_error: true, num_turns: 1, result },
  ],
  exitCode: 1,
})

const run = async (
  replies: Array<Reply>,
  context: Context,
  options?: SimpleStreamOptions,
) => {
  process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify(replies)
  const stream = ClaudeCli.stream(Helpers.model, normalizeContext(context), options)
  const events: Array<string> = []
  for await (const next of stream) {
    events.push(next.type)
  }
  const received: {
    args: Array<string>
    env: Record<string, string | undefined>
    systemPrompt: string
    settings: { env: { CLAUDE_CODE_EXTRA_BODY: string } }
    input: Array<unknown>
  } = JSON.parse(await readFile(log, 'utf8'))
  return { message: await stream.result(), events, received }
}

describe('stream', () => {
  it('streams a text reply with its usage and cost', async () => {
    const { message, events } = await run([reply('msg_1', 'Hello there')], {
      messages: [Helpers.user('Hi')],
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
    assert.closeTo(message.usage.cost.total, 0.000163, 1e-9)
    deepStrictEqual(events, [
      'start',
      'text_start',
      'text_delta',
      'text_end',
      'done',
    ])
  })

  it('returns the tool call and ignores what Claude Code does after the first message', async () => {
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
            ...reply('msg_2', 'I could not run that tool.').lines,
          ],
        },
      ],
      { messages: [Helpers.user('Read a.txt')] },
    )

    expect(message).toMatchObject({ stopReason: 'toolUse', responseId: 'msg_1' })
    deepStrictEqual(message.content, [
      {
        type: 'toolCall',
        id: 'toolu_1',
        name: 'read',
        arguments: { path: 'a.txt' },
      },
    ])
  })

  it("sends pi's conversation, prompt and tools in place of Claude Code's own", async () => {
    const { received } = await run(
      [reply('msg_1', 'Done')],
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
          Helpers.user('Read a.txt'),
          Helpers.assistant([
            {
              type: 'toolCall',
              id: 'call|1',
              name: 'read',
              arguments: { path: 'a.txt' },
            },
          ]),
          Helpers.toolResult('call|1', 'contents'),
        ],
      },
      { cacheRetention: 'long' },
    )

    assert.strictEqual(received.systemPrompt, 'Be terse.')
    deepStrictEqual(JSON.parse(received.settings.env.CLAUDE_CODE_EXTRA_BODY), {
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
              content: 'contents',
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
    assert.strictEqual(received.env['CLAUDE_CODE_PROMPT_CACHE_TTL'], '1h')
    // Claude Code fingerprints the first user message in its billing header.
    deepStrictEqual(received.input, [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      },
    ])
  })

  it('passes Claude Code a conversation beyond the limits of settings files and the environment', async () => {
    const contents = 'x'.repeat(3 * 1024 * 1024)
    const { message, received } = await run([reply('msg_1', 'Done')], {
      messages: [
        Helpers.user('Read a.txt'),
        Helpers.assistant([
          { type: 'toolCall', id: 'call_1', name: 'read', arguments: {} },
        ]),
        Helpers.toolResult('call_1', contents),
      ],
    })

    assert.strictEqual(message.stopReason, 'stop')
    expect(JSON.parse(received.settings.env.CLAUDE_CODE_EXTRA_BODY)).toMatchObject({
      messages: [{}, {}, { content: [{ type: 'tool_result', content: contents }] }],
    })
  })

  it('sends no prompt when Claude Code refuses the request body', async () => {
    const { message, received } = await run(
      [{ lines: [], settingsError: 'Unsupported control request subtype' }],
      { messages: [Helpers.user('Hi')] },
    )

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage:
        'Claude Code did not accept the request: Unsupported control request subtype',
    })
    deepStrictEqual(received.input, [])
  })

  it('keeps an API key in the environment away from Claude Code', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-ant-test'
    try {
      const { message, received } = await run([reply('msg_1', 'Hi')], {
        messages: [Helpers.user('Hi')],
      })
      assert.strictEqual(message.stopReason, 'stop')
      assert.isUndefined(received.env['ANTHROPIC_API_KEY'])
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  it('keeps Claude Code out of auto mode and its tool use classifier', async () => {
    const { received } = await run([reply('msg_1', 'Hi')], {
      messages: [Helpers.user('Hi')],
    })

    assert.include(received.args.join(' '), '--permission-mode default')
  })

  it('runs at the requested effort and turns thinking off without a level', async () => {
    const minimal = await run(
      [reply('msg_1', 'Hi')],
      { messages: [Helpers.user('Hi')] },
      { reasoning: 'minimal' },
    )
    const off = await run([reply('msg_2', 'Hi')], { messages: [Helpers.user('Hi')] })

    assert.include(minimal.received.args.join(' '), '--effort low')
    assert.isUndefined(minimal.received.env['CLAUDE_CODE_DISABLE_THINKING'])
    assert.notInclude(off.received.args, '--effort')
    assert.strictEqual(off.received.env['CLAUDE_CODE_DISABLE_THINKING'], '1')
  })

  it("reports Claude Code's error when no response arrives", async () => {
    const { message } = await run([failure('API Error: 529 Overloaded')], {
      messages: [Helpers.user('Hi')],
    })

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage: 'API Error: 529 Overloaded',
    })
  })

  it('reports an unknown stop reason as an error that pi can recognize', async () => {
    const { message } = await run(
      [reply('msg_1', 'cut off', 'model_context_window_exceeded')],
      { messages: [Helpers.user('Hi')] },
    )

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage: 'Unhandled stop reason: model_context_window_exceeded',
    })
  })

  it('retries while another Claude Code process refreshes the login', async () => {
    const { message } = await run(
      [
        failure(
          'Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh)',
        ),
        reply('msg_1', 'Hello'),
      ],
      { messages: [Helpers.user('Hi')] },
    )

    expect(message).toMatchObject({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Hello' }],
    })
  })

  it('stops a running request when aborted', async () => {
    process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify([
      { lines: reply('msg_1', 'Hel').lines.slice(0, 3) },
    ])
    const controller = new AbortController()
    const stream = ClaudeCli.stream(
      Helpers.model,
      normalizeContext({ messages: [Helpers.user('Hi')] }),
      { signal: controller.signal },
    )
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
