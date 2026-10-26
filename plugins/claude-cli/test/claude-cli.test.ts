import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isRetryableAssistantError,
  normalizeContext,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai'
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  afterAll,
  afterEach,
  assert,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from '@effect/vitest'
import { deepStrictEqual } from '@effect/vitest/utils'
import { Array, Effect, Layer, Number, Option, pipe, Stream, String } from 'effect'
import * as ClaudeCli from '../src/claude-cli'

type Reply = {
  lines: Array<unknown>
  delayMs?: number
  exitCode?: number
  settingsError?: string
}

const model: Model<Api> = {
  ...getBuiltinModel('anthropic', 'claude-haiku-4-5'),
  provider: 'claude-cli',
  api: 'claude-cli',
}

const user = (text: string): Message => ({
  role: 'user',
  content: text,
  timestamp: 0,
})

const assistant = (content: AssistantMessage['content']): Message => ({
  role: 'assistant',
  content,
  api: model.api,
  provider: model.provider,
  model: model.id,
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason: 'stop',
  timestamp: 0,
})

const toolResult = (toolCallId: string, text: string): Message => ({
  role: 'toolResult',
  toolCallId,
  toolName: 'read',
  content: [{ type: 'text', text }],
  isError: false,
  timestamp: 0,
})

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
  await rm(`${log}.started`, { force: true })
  await rm(`${log}.stopped`, { force: true })
})

// So that no test gets a process started ahead in another.
afterEach(() => ClaudeCli.release())

afterAll(() => rm(dir, { recursive: true, force: true }))

const event = (payload: object) => ({ type: 'stream_event', event: payload })

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

// What Claude Code reports after the response about the limits that paid for it.
const limits = (isUsingOverage: boolean) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', isUsingOverage },
})
const success = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  num_turns: 1,
}

const reply = (id: string, text: string, isUsingOverage = false): Reply => ({
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
    limits(isUsingOverage),
    success,
  ],
})

const failure = (result: string): Reply => ({
  lines: [
    { type: 'result', subtype: 'success', is_error: true, num_turns: 1, result },
  ],
  exitCode: 1,
})

const pids = async (kind: 'started' | 'stopped') =>
  pipe(
    await readFile(`${log}.${kind}`, 'utf8').catch(() => ''),
    String.split('\n'),
    Array.map(Number.parse),
    Array.getSomes,
  )

const run = async (
  replies: Array<Reply>,
  context: Context,
  options?: SimpleStreamOptions,
  target = model,
) => {
  process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify(replies)
  const stream = ClaudeCli.stream(target, normalizeContext(context), options)
  const events: Array<string> = []
  for await (const next of stream) {
    events.push(next.type)
  }
  const received: {
    pid: number
    startedAt: number
    cwd: string
    args: Array<string>
    env: Record<string, string | undefined>
    systemPrompt: string
    settings: { env?: { CLAUDE_CODE_EXTRA_BODY: string } }
    input: Array<unknown>
  } = JSON.parse(await readFile(log, 'utf8'))
  // The request body Claude Code applied, if it accepted one.
  const body: Record<string, unknown> = JSON.parse(
    received.settings.env?.CLAUDE_CODE_EXTRA_BODY ?? '{}',
  )
  return { message: await stream.result(), events, received, body }
}

describe('stream', () => {
  it('streams a text reply with its usage and cost', async () => {
    const { message, events } = await run([reply('msg_1', 'Hello there')], {
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
      { messages: [user('Read a.txt')] },
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

  it("sends pi's request in place of Claude Code's own", async () => {
    const { received, body } = await run(
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
        messages: [user('Read a.txt')],
      },
      { cacheRetention: 'long' },
    )

    assert.strictEqual(received.systemPrompt, 'Be terse.')
    expect(body).toMatchObject({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Read a.txt',
              cache_control: { type: 'ephemeral', ttl: '1h' },
            },
          ],
        },
      ],
      tools: [{ name: 'read', description: 'Read a file' }],
    })
    // Claude Code keeps its own model, billing header, identity and metadata.
    assert.doesNotHaveAnyKeys(body, ['model', 'system', 'stream', 'metadata'])
    assert.strictEqual(received.env['CLAUDE_CODE_PROMPT_CACHE_TTL'], '1h')
    // Claude Code fingerprints the first user message in its billing header.
    deepStrictEqual(received.input, [
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'Read a.txt' }] },
      },
    ])
  })

  it('keeps a later system prompt change in the conversation, where it leaves the cache intact', async () => {
    const { received, body } = await run(
      [reply('msg_1', 'Bonjour')],
      {
        systemPrompt: 'Be terse.',
        messages: [
          user('Hi'),
          assistant([{ type: 'text', text: 'Hello' }]),
          { role: 'system', content: 'Answer in French.', timestamp: 0 },
          user('Hi again'),
        ],
      },
      undefined,
      {
        ...getBuiltinModel('anthropic', 'claude-opus-4-8'),
        provider: 'claude-cli',
        api: 'claude-cli',
      },
    )

    assert.strictEqual(received.systemPrompt, 'Be terse.')
    expect(body).toMatchObject({
      messages: [
        { role: 'user' },
        { role: 'assistant' },
        { role: 'user' },
        { role: 'system', content: [{ type: 'text', text: 'Answer in French.' }] },
      ],
    })
  })

  it('turns caching off in Claude Code when pi has it off', async () => {
    const { received } = await run(
      [reply('msg_1', 'Hi')],
      { systemPrompt: 'Be terse.', messages: [user('Hi')] },
      { cacheRetention: 'none' },
    )

    assert.strictEqual(received.env['DISABLE_PROMPT_CACHING'], '1')
    assert.isUndefined(received.env['CLAUDE_CODE_PROMPT_CACHE_TTL'])
  })

  it("passes pi's beta flags on to Claude Code", async () => {
    const { received } = await run(
      [reply('msg_1', 'Hi')],
      { messages: [user('Hi')] },
      { reasoning: 'low' },
    )

    assert.include(
      received.env['ANTHROPIC_BETAS'],
      'interleaved-thinking-2025-05-14',
    )
  })

  it('runs the requests of a pi session as one Claude Code session', async () => {
    const sessionId = '018f2a3b-1c2d-7e4f-8a9b-0c1d2e3f4a5b'
    const { received } = await run(
      [reply('msg_1', 'Hi')],
      { messages: [user('Hi')] },
      { sessionId },
    )

    assert.include(received.args.join(' '), `--session-id ${sessionId}`)
  })

  it('passes Claude Code a conversation beyond the limits of settings files and the environment', async () => {
    const contents = 'x'.repeat(3 * 1024 * 1024)
    const { message, body } = await run([reply('msg_1', 'Done')], {
      messages: [
        user('Read a.txt'),
        assistant([{ type: 'toolCall', id: 'call_1', name: 'read', arguments: {} }]),
        toolResult('call_1', contents),
      ],
    })

    assert.strictEqual(message.stopReason, 'stop')
    expect(body).toMatchObject({
      messages: [{}, {}, { content: [{ type: 'tool_result', content: contents }] }],
    })
  })

  it('sends no prompt when Claude Code refuses the request body', async () => {
    const { message, received } = await run(
      [{ lines: [], settingsError: 'Unsupported control request subtype' }],
      { messages: [user('Hi')] },
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
        messages: [user('Hi')],
      })
      assert.strictEqual(message.stopReason, 'stop')
      assert.isUndefined(received.env['ANTHROPIC_API_KEY'])
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  it("runs Claude Code in pi's working directory after it was moved", async () => {
    const previous = process.cwd()
    const workspace = await mkdtemp(join(tmpdir(), 'claude-cli-workspace-'))
    process.chdir(workspace)
    // As pi does at startup. Node caches the path from then on.
    process.cwd()
    await rename(workspace, `${workspace}-moved`)
    try {
      const { message, received } = await run([reply('msg_1', 'Hi')], {
        messages: [user('Hi')],
      })

      assert.strictEqual(message.stopReason, 'stop')
      assert.strictEqual(received.cwd, await realpath(`${workspace}-moved`))
    } finally {
      process.chdir(previous)
      await rm(`${workspace}-moved`, { recursive: true, force: true })
    }
  })

  it('keeps Claude Code out of auto mode and its tool use classifier', async () => {
    const { received } = await run([reply('msg_1', 'Hi')], {
      messages: [user('Hi')],
    })

    assert.include(received.args.join(' '), '--permission-mode default')
  })

  it('turns thinking off in Claude Code when pi has it off', async () => {
    const off = await run([reply('msg_1', 'Hi')], { messages: [user('Hi')] })
    const low = await run(
      [reply('msg_2', 'Hi')],
      { messages: [user('Hi')] },
      { reasoning: 'low' },
    )

    assert.strictEqual(off.received.env['CLAUDE_CODE_DISABLE_THINKING'], '1')
    assert.isUndefined(low.received.env['CLAUDE_CODE_DISABLE_THINKING'])
  })

  it("reports Claude Code's error when no response arrives", async () => {
    const { message } = await run([failure('API Error: 529 Overloaded')], {
      messages: [user('Hi')],
    })

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage: 'API Error: 529 Overloaded',
    })
  })

  it('stops when Claude Code charges the response to usage credits', async () => {
    const { message } = await run([reply('msg_1', 'Hello', true)], {
      messages: [user('Hi')],
    })

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage: expect.stringContaining('usage credits'),
    })
    assert.isFalse(isRetryableAssistantError(message))
  })

  it.live('lets a response charged to usage credits through when allowed', () =>
    Effect.gen(function* () {
      process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify([
        reply('msg_1', 'Hello', true),
      ])
      const claudeCli = yield* ClaudeCli.ClaudeCli
      const response = yield* claudeCli
        .request({
          model: model.id,
          body: JSON.stringify({ messages: [{ role: 'user', content: 'Hi' }] }),
          betas: Option.none(),
          sessionId: Option.none(),
        })
        .pipe(Stream.decodeText, Stream.mkString)

      assert.include(response, 'event: message_stop')
    }).pipe(
      Effect.provide(
        Layer.effect(
          ClaudeCli.ClaudeCli,
          ClaudeCli.ClaudeCli.make({ allowUsageCredits: true }),
        ).pipe(Layer.provide(NodeServices.layer)),
      ),
    ),
  )

  it('does not retry a request Anthropic would charge to usage credits', async () => {
    const result =
      'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"You\'re out of extra usage. Add more at claude.ai/settings/usage and keep going."}}'
    const { message } = await run([failure(result)], { messages: [user('Hi')] })

    expect(message).toMatchObject({
      stopReason: 'error',
      errorMessage: expect.stringContaining(result),
    })
    assert.isFalse(isRetryableAssistantError(message))
  })

  it('finishes the response when Claude Code ends without reporting its limits', async () => {
    const { message } = await run(
      [{ lines: Array.dropRight(reply('msg_1', 'Hello').lines, 2), exitCode: 0 }],
      { messages: [user('Hi')] },
    )

    expect(message).toMatchObject({
      stopReason: 'stop',
      content: [{ type: 'text', text: 'Hello' }],
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
      { messages: [user('Hi')] },
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
      model,
      normalizeContext({ messages: [user('Hi')] }),
      { signal: controller.signal },
    )
    for await (const next of stream) {
      if (next.type === 'text_delta') {
        controller.abort()
      }
    }

    expect(await stream.result()).toMatchObject({
      stopReason: 'aborted',
      errorMessage: 'Request was aborted',
      content: [{ type: 'text', text: 'Hel' }],
    })
  })

  it('stops Claude Code when pi stops reading the response early', async () => {
    process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify([
      { ...reply('msg_1', 'Hello'), delayMs: 50 },
    ])
    const stream = ClaudeCli.stream(
      model,
      normalizeContext({ messages: [user('Hi')] }),
      {
        onProviderStreamEvent: () => {
          throw new Error('Hook failed')
        },
      },
    )

    assert.strictEqual((await stream.result()).errorMessage, 'Hook failed')
    const { pid } = JSON.parse(await readFile(log, 'utf8'))
    await vi.waitFor(async () => assert.include(await pids('stopped'), pid))
  })

  it('answers a request with a Claude Code process started ahead by the one before', async () => {
    const options = { sessionId: randomUUID() }
    await run([reply('msg_1', 'Hi')], { messages: [user('Hi')] }, options)
    await run([reply('msg_2', 'Hi')], { messages: [user('Hi')] }, options)
    await vi.waitFor(async () => assert.lengthOf(await pids('started'), 3))
    const requested = Date.now()
    const { message, received } = await run(
      [reply('msg_3', 'Hi')],
      { messages: [user('Hi')] },
      options,
    )

    assert.strictEqual(message.stopReason, 'stop')
    assert.isBelow(received.startedAt, requested)
  })

  it('starts no process ahead for the first request of a session, such as a summary', async () => {
    const options = { sessionId: randomUUID() }
    await run([reply('msg_1', 'Hi')], { messages: [user('Hi')] }, options)
    const requested = Date.now()
    const { received } = await run(
      [reply('msg_2', 'Hi')],
      { messages: [user('Hi')] },
      options,
    )

    assert.isAtLeast(received.startedAt, requested)
  })

  it('starts Claude Code afresh when the next request needs another setup', async () => {
    const options = { sessionId: randomUUID() }
    const terse = { systemPrompt: 'Be terse.', messages: [user('Hi')] }
    await run([reply('msg_1', 'Hi')], terse, options)
    await run([reply('msg_2', 'Hi')], terse, options)
    const requested = Date.now()
    const { received } = await run(
      [reply('msg_3', 'Hi')],
      { systemPrompt: 'Be verbose.', messages: [user('Hi')] },
      options,
    )

    assert.strictEqual(received.systemPrompt, 'Be verbose.')
    assert.isAtLeast(received.startedAt, requested)
  })

  it('stops the processes started ahead when released', async () => {
    const options = { sessionId: randomUUID() }
    await run([reply('msg_1', 'Hi')], { messages: [user('Hi')] }, options)
    await run([reply('msg_2', 'Hi')], { messages: [user('Hi')] }, options)
    await vi.waitFor(async () => assert.lengthOf(await pids('started'), 3))
    await ClaudeCli.release()

    assert.sameMembers(await pids('stopped'), await pids('started'))
  })

  it('keeps one process ahead per session when its requests overlap', async () => {
    process.env['FAKE_CLAUDE_REPLIES'] = JSON.stringify([reply('msg_1', 'Hi')])
    const options = { sessionId: randomUUID() }
    const request = () =>
      ClaudeCli.stream(
        model,
        normalizeContext({ messages: [user('Hi')] }),
        options,
      ).result()
    await request()
    await Promise.all([request(), request(), request()])
    await ClaudeCli.release()

    assert.sameMembers(await pids('stopped'), await pids('started'))
  })
})
