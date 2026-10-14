import {
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  parseStreamingJson,
  type AnthropicMessagesCompat,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
  type UserMessage,
} from '@earendil-works/pi-ai'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Cause,
  Config,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Filter,
  Path,
  Schedule,
  Schema,
  Stream,
} from 'effect'
import { ChildProcess } from 'effect/unstable/process'
import * as Messages from './messages'

class ClaudeCodeError extends Schema.TaggedError<ClaudeCodeError>()(
  'ClaudeCodeError',
  {
    reason: Schema.Literals(['NotInstalled', 'LoginBusy', 'NoResponse']),
    output: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return this.reason === 'NotInstalled'
      ? 'Claude Code CLI not found. Install `claude` on your PATH and sign in with `claude auth login`.'
      : this.output || 'Claude Code exited without a response.'
  }
}

const thinkingBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 }

const Tokens = Schema.optional(Schema.NullOr(Schema.Number))

const Usage = Schema.Struct({
  input_tokens: Tokens,
  output_tokens: Tokens,
  cache_read_input_tokens: Tokens,
  cache_creation_input_tokens: Tokens,
  cache_creation: Schema.optional(
    Schema.NullOr(Schema.Struct({ ephemeral_1h_input_tokens: Tokens })),
  ),
  output_tokens_details: Schema.optional(
    Schema.NullOr(Schema.Struct({ thinking_tokens: Tokens })),
  ),
})

const Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal('message_start'),
    message: Schema.Struct({
      id: Schema.String,
      model: Schema.String,
      usage: Usage,
    }),
  }),
  Schema.Struct({
    type: Schema.Literal('content_block_start'),
    index: Schema.Number,
    content_block: Schema.Union([
      Schema.Struct({ type: Schema.Literal('text') }),
      Schema.Struct({
        type: Schema.Literal('thinking'),
        signature: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        type: Schema.Literal('redacted_thinking'),
        data: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal('tool_use'),
        id: Schema.String,
        name: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal('content_block_delta'),
    index: Schema.Number,
    delta: Schema.Union([
      Schema.Struct({ type: Schema.Literal('text_delta'), text: Schema.String }),
      Schema.Struct({
        type: Schema.Literal('thinking_delta'),
        thinking: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal('signature_delta'),
        signature: Schema.String,
      }),
      Schema.Struct({
        type: Schema.Literal('input_json_delta'),
        partial_json: Schema.String,
      }),
    ]),
  }),
  Schema.Struct({
    type: Schema.Literal('content_block_stop'),
    index: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literal('message_delta'),
    delta: Schema.Struct({
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
    usage: Schema.optional(Schema.NullOr(Usage)),
  }),
  Schema.Struct({ type: Schema.Literal('message_stop') }),
])

const Line = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal('stream_event'), event: Event }),
    Schema.Struct({
      type: Schema.Literal('result'),
      num_turns: Schema.Number,
      result: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ]),
)

const encoder = new TextEncoder()

/**
 * Runs one pi model request as one `claude --print` process. Claude Code signs
 * the request while pi supplies the conversation, tools and thinking settings
 * through `CLAUDE_CODE_EXTRA_BODY`. The process is stopped after the first
 * response, before Claude Code can act on it.
 */
export function stream(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const events = createAssistantMessageEventStream()
  const output: AssistantMessage = {
    role: 'assistant',
    content: [],
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
    stopReason: 'pending',
    timestamp: Date.now(),
  }
  let settled = false
  const fail = (message: string): void => {
    if (settled) {
      return
    }
    settled = true
    output.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
    output.errorMessage = message
    events.push({ type: 'error', reason: output.stopReason, error: output })
    events.end()
  }

  const applyUsage = (usage: (typeof Usage)['Type']): void => {
    const target = output.usage
    target.input = usage.input_tokens ?? target.input
    target.output = usage.output_tokens ?? target.output
    target.cacheRead = usage.cache_read_input_tokens ?? target.cacheRead
    target.cacheWrite = usage.cache_creation_input_tokens ?? target.cacheWrite
    target.cacheWrite1h =
      usage.cache_creation?.ephemeral_1h_input_tokens ?? target.cacheWrite1h
    target.reasoning =
      usage.output_tokens_details?.thinking_tokens ?? target.reasoning
    target.totalTokens =
      target.input + target.output + target.cacheRead + target.cacheWrite
    calculateCost(model, target)
  }

  // Native content block index to the pi block and its partial tool input.
  const blocks = new Map<number, { index: number; json: string }>()

  const apply = (event: (typeof Event)['Type']): void => {
    if (event.type === 'message_start') {
      events.push({ type: 'start', partial: output })
      output.responseId = event.message.id
      if (event.message.model !== model.id) {
        output.responseModel = event.message.model
      }
      applyUsage(event.message.usage)
    } else if (event.type === 'content_block_start') {
      const index = output.content.length
      const block = event.content_block
      blocks.set(event.index, { index, json: '' })
      if (block.type === 'text') {
        output.content.push({ type: 'text', text: '' })
        events.push({ type: 'text_start', contentIndex: index, partial: output })
      } else if (block.type === 'tool_use') {
        output.content.push({
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: {},
        })
        events.push({
          type: 'toolcall_start',
          contentIndex: index,
          partial: output,
        })
      } else {
        output.content.push(
          block.type === 'thinking'
            ? {
                type: 'thinking',
                thinking: '',
                thinkingSignature: block.signature ?? '',
              }
            : {
                type: 'thinking',
                thinking: '[Reasoning redacted]',
                thinkingSignature: block.data,
                redacted: true,
              },
        )
        events.push({
          type: 'thinking_start',
          contentIndex: index,
          partial: output,
        })
      }
    } else if (event.type === 'content_block_delta') {
      const entry = blocks.get(event.index)
      const block = entry && output.content[entry.index]
      const delta = event.delta
      if (!entry || !block) {
        return
      }
      if (delta.type === 'text_delta' && block.type === 'text') {
        block.text += delta.text
        events.push({
          type: 'text_delta',
          contentIndex: entry.index,
          delta: delta.text,
          partial: output,
        })
      } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
        block.thinking += delta.thinking
        events.push({
          type: 'thinking_delta',
          contentIndex: entry.index,
          delta: delta.thinking,
          partial: output,
        })
      } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
        block.thinkingSignature = (block.thinkingSignature ?? '') + delta.signature
      } else if (delta.type === 'input_json_delta' && block.type === 'toolCall') {
        entry.json += delta.partial_json
        block.arguments = parseStreamingJson(entry.json)
        events.push({
          type: 'toolcall_delta',
          contentIndex: entry.index,
          delta: delta.partial_json,
          partial: output,
        })
      }
    } else if (event.type === 'content_block_stop') {
      const entry = blocks.get(event.index)
      const block = entry && output.content[entry.index]
      if (!entry || !block) {
        return
      }
      if (block.type === 'text') {
        events.push({
          type: 'text_end',
          contentIndex: entry.index,
          content: block.text,
          partial: output,
        })
      } else if (block.type === 'thinking') {
        events.push({
          type: 'thinking_end',
          contentIndex: entry.index,
          content: block.thinking,
          partial: output,
        })
      } else {
        block.arguments = parseStreamingJson(entry.json)
        events.push({
          type: 'toolcall_end',
          contentIndex: entry.index,
          toolCall: block,
          partial: output,
        })
      }
    } else if (event.type === 'message_delta') {
      const reason = event.delta.stop_reason
      if (reason) {
        output.rawStopReason = reason
        if (reason === 'tool_use') {
          output.stopReason = 'toolUse'
        } else if (reason === 'max_tokens') {
          output.stopReason = 'length'
        } else if (reason === 'refusal') {
          output.stopReason = 'error'
          output.errorMessage = 'The model refused to complete the request'
        } else {
          output.stopReason = 'stop'
        }
      }
      if (event.usage) {
        applyUsage(event.usage)
      }
    }
  }

  const program = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const transcript = collapseSystemMessages(context).messages
    const retentionSetting = yield* Config.String('PI_CACHE_RETENTION').pipe(
      Config.withDefault('short'),
    )
    const retention =
      options?.cacheRetention ?? (retentionSetting === 'long' ? 'long' : 'short')
    const cacheTtl =
      retention === 'none' ? undefined : retention === 'long' ? '1h' : '5m'

    // Mirrors pi's Anthropic provider, including its default thinking budgets.
    const compat = model.compat as AnthropicMessagesCompat | undefined
    const managedEffort = compat?.supportsMidConvoEffort === true
    const level = options?.reasoning
    const mapped = level && model.thinkingLevelMap?.[level]
    const effort =
      typeof mapped === 'string' ? mapped : level === 'minimal' ? 'low' : level
    let thinking: Record<string, unknown> | undefined
    let maxTokens = options?.maxTokens
    if (model.reasoning && (compat?.forceAdaptiveThinking || managedEffort)) {
      if (level !== undefined || managedEffort) {
        thinking = {
          type: 'adaptive',
          display: 'summarized',
          ...(managedEffort && {
            block_binding: { prefix_mismatch_behavior: 'drop_block' },
          }),
        }
      }
    } else if (model.reasoning && level !== undefined) {
      const budgets = { ...thinkingBudgets, ...options?.thinkingBudgets }
      const budget = budgets[level === 'xhigh' || level === 'max' ? 'high' : level]
      maxTokens = Math.min(
        (options?.maxTokens ?? model.maxTokens) + budget,
        model.maxTokens,
      )
      thinking = {
        type: 'enabled',
        budget_tokens: Math.min(budget, maxTokens - 1024),
        display: 'summarized',
      }
    }

    const body = {
      messages: Messages.fromTranscript(transcript, model, cacheTtl),
      tools: getCurrentTools(transcript).map((tool) => {
        const schema = tool.parameters as {
          properties?: unknown
          required?: unknown
        }
        return {
          name: tool.name,
          description: tool.description,
          input_schema: {
            type: 'object',
            properties: schema.properties ?? {},
            required: schema.required ?? [],
          },
        }
      }),
      ...(options?.toolChoice && { tool_choice: { type: options.toolChoice } }),
      ...(maxTokens !== undefined && { max_tokens: maxTokens }),
      ...(thinking && { thinking }),
    }

    // Files rather than arguments, which are limited to 128 KiB each on Linux.
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'pi-claude-code-' })
    const systemPromptFile = path.join(dir, 'system-prompt.md')
    const settingsFile = path.join(dir, 'settings.json')
    yield* fs.writeFileString(systemPromptFile, getCurrentSystemPrompt(transcript))
    yield* fs.writeFileString(
      settingsFile,
      JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(body) } }),
    )

    // `messages` above replaces Claude Code's own conversation, but its billing
    // header carries a fingerprint of the first user message, so that message
    // is pi's too.
    const first = transcript.find(
      (message): message is UserMessage => message.role === 'user',
    )
    const prompt =
      typeof first?.content === 'string'
        ? first.content
        : first?.content.find((block) => block.type === 'text')?.text
    const input = `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt || '.' }] },
    })}\n`

    const request = Effect.gen(function* () {
      const handle = yield* ChildProcess.make(
        'claude',
        [
          '--print',
          '--model',
          model.contextWindow >= 1_000_000 ? `${model.id}[1m]` : model.id,
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--system-prompt-file',
          systemPromptFile,
          '--settings',
          settingsFile,
          '--setting-sources',
          '',
          '--tools',
          '',
          '--strict-mcp-config',
          '--disable-slash-commands',
          '--no-session-persistence',
          '--max-turns',
          '1',
          ...(effort ? ['--effort', effort] : []),
        ],
        {
          cwd: process.cwd(),
          extendEnv: true,
          env: {
            // An API key would silently bill the API instead of the subscription.
            ANTHROPIC_API_KEY: undefined,
            ANTHROPIC_AUTH_TOKEN: undefined,
            ANTHROPIC_BASE_URL: undefined,
            // Pi owns retries, compaction and the token budget.
            CLAUDE_CODE_MAX_RETRIES: '0',
            DISABLE_AUTO_COMPACT: '1',
            CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
            CLAUDE_CODE_DISABLE_THINKING:
              !level && model.thinkingLevelMap?.off !== null ? '1' : undefined,
            // The cache anchor must not outlive the breakpoints Claude Code
            // places in the system prompt before it, so both use the same TTL.
            CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl,
            DISABLE_PROMPT_CACHING: cacheTtl === undefined ? '1' : undefined,
          },
          stdin: Stream.make(encoder.encode(input)),
          forceKillAfter: '3 seconds',
        },
      ).pipe(
        Effect.catchReason('PlatformError', 'NotFound', () =>
          Effect.fail(new ClaudeCodeError({ reason: 'NotInstalled' })),
        ),
      )

      const stderr = yield* Effect.forkScoped(
        handle.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => '',
            (acc, chunk) => (acc + chunk).slice(-4096),
          ),
        ),
      )

      let result: string | undefined
      let stopped = false
      yield* handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filterMap(
          Filter.fromPredicateOption(Schema.decodeUnknownOption(Line)),
        ),
        Stream.takeUntil(
          (line) =>
            line.type === 'stream_event' && line.event.type === 'message_stop',
        ),
        Stream.runForEach((line) =>
          Effect.sync(() => {
            if (line.type === 'result') {
              result = line.result ?? undefined
            } else if (line.event.type === 'message_stop') {
              stopped = true
            } else {
              apply(line.event)
            }
          }),
        ),
      )

      if (!stopped) {
        const exitCode = yield* handle.exitCode
        const log = (yield* Fiber.join(stderr)).trim()
        const detail = result || log || `Claude Code exited with code ${exitCode}.`
        return yield* new ClaudeCodeError({
          reason: detail.includes('another Claude Code process is refreshing')
            ? 'LoginBusy'
            : 'NoResponse',
          output: detail,
        })
      }
      const reason = output.stopReason
      if (reason !== 'stop' && reason !== 'length' && reason !== 'toolUse') {
        return fail(
          output.errorMessage ?? 'Claude Code ended without a stop reason.',
        )
      }
      settled = true
      events.push({ type: 'done', reason, message: output })
      events.end()
    }).pipe(Effect.scoped)

    // Claude Code fails instead of waiting when another process holds its
    // login refresh lock, and suggests trying again within a minute.
    yield* request.pipe(
      Effect.retry({
        while: (error) =>
          error._tag === 'ClaudeCodeError' && error.reason === 'LoginBusy',
        schedule: Schedule.exponential('1 second'),
        times: 6,
      }),
    )
  })

  void Effect.runPromiseExit(
    program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { signal: options?.signal },
  ).then((exit) => {
    if (Exit.isSuccess(exit)) {
      return
    }
    const error = Cause.squash(exit.cause)
    fail(
      Cause.hasInterruptsOnly(exit.cause)
        ? 'Request was aborted'
        : error instanceof Error
          ? error.message
          : String(error),
    )
  })

  return events
}
