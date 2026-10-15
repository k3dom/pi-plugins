import {
  calculateCost,
  collapseSystemMessages,
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  parseStreamingJson,
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type TranscriptContext,
  type UserMessage,
} from '@earendil-works/pi-ai'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Run from '@pi-plugins/shared/run'
import {
  Array,
  Config,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Filter,
  Latch,
  Layer,
  Match,
  Option,
  Path,
  pipe,
  Predicate,
  Schedule,
  Schema,
  Stream,
  String,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as Payload from './payload'

export class NotInstalledError extends Schema.TaggedError<NotInstalledError>()(
  'NotInstalledError',
  {},
) {}

export class LoginBusyError extends Schema.TaggedError<LoginBusyError>()(
  'LoginBusyError',
  { result: Schema.String },
) {}

export class RejectedError extends Schema.TaggedError<RejectedError>()(
  'RejectedError',
  { error: Schema.String },
) {}

export class NoResponseError extends Schema.TaggedError<NoResponseError>()(
  'NoResponseError',
  { exitCode: Schema.Number, result: Schema.optional(Schema.String) },
) {}

export class ProcessError extends Schema.TaggedError<ProcessError>()(
  'ProcessError',
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return Predicate.isError(this.cause)
      ? this.cause.message
      : globalThis.String(this.cause)
  }
}

export class ClaudeCliError extends Schema.TaggedError<ClaudeCliError>()(
  'ClaudeCliError',
  {
    reason: Schema.Union([
      NotInstalledError,
      LoginBusyError,
      RejectedError,
      NoResponseError,
      ProcessError,
    ]),
    stderr: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return Match.valueTags(this.reason, {
      NotInstalledError: () =>
        'Claude Code CLI not found. Install `claude` on your PATH and sign in with `claude auth login`.',
      LoginBusyError: ({ result }) => result,
      RejectedError: ({ error }) =>
        `Claude Code did not accept the request: ${error}`,
      NoResponseError: ({ exitCode, result }) =>
        result ||
        String.trim(this.stderr ?? '') ||
        `Claude Code exited with code ${exitCode}.`,
      ProcessError: (reason) => `Failed to run Claude Code: ${reason.message}`,
    })
  }
}

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

type Event = typeof Event.Type

const Line = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal('stream_event'), event: Event }),
    Schema.Struct({
      type: Schema.Literal('control_response'),
      response: Schema.Union([
        Schema.Struct({ subtype: Schema.Literal('success') }),
        Schema.Struct({ subtype: Schema.Literal('error'), error: Schema.String }),
      ]),
    }),
    Schema.Struct({
      type: Schema.Literal('result'),
      result: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ]),
)

export class ClaudeCli extends Context.Service<ClaudeCli>()(
  '@pi-plugins/claude-cli/ClaudeCli',
  {
    make: Effect.fnUntraced(function* (cacheRetention: 'short' | 'long') {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      // Sends one pi model request through one `claude --print` process and
      // hands its response events to `onEvent` up to the first `message_stop`.
      // The process is stopped there, before Claude Code can act on the
      // response.
      const request = Effect.fn('ClaudeCli.request')(
        function* (options: {
          readonly model: Model<Api>
          readonly context: TranscriptContext
          readonly stream: SimpleStreamOptions | undefined
          readonly onEvent: (event: Event) => void
        }) {
          const { model } = options
          const transcript = collapseSystemMessages(options.context).messages
          const cacheTtl = ({ none: undefined, short: '5m', long: '1h' } as const)[
            options.stream?.cacheRetention ?? cacheRetention
          ]
          const payload = Payload.make(transcript, model, options.stream, cacheTtl)

          // A file rather than an argument, which is limited to 128 KiB on
          // Linux.
          const dir = yield* fs.makeTempDirectoryScoped({
            prefix: 'pi-claude-cli-',
          })
          const systemPromptFile = path.join(dir, 'system-prompt.md')
          yield* fs.writeFileString(
            systemPromptFile,
            getCurrentSystemPrompt(transcript),
          )

          // Claude Code's billing header carries a fingerprint of the first
          // user message, so it gets pi's.
          const prompt = pipe(
            Array.findFirst(
              transcript,
              (message): message is UserMessage => message.role === 'user',
            ),
            Option.flatMap((message) =>
              Predicate.isString(message.content)
                ? Option.some(message.content)
                : pipe(
                    Array.findFirst(
                      message.content,
                      (block): block is TextContent => block.type === 'text',
                    ),
                    Option.map((block) => block.text),
                  ),
            ),
            Option.filter(String.isNonEmpty),
            Option.getOrElse(() => '.'),
          )

          // Held back until Claude Code has applied pi's request body, so it
          // never answers the prompt without pi's conversation.
          const applied = yield* Latch.make()

          const handle = yield* spawner
            .spawn(
              ChildProcess.make(
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
                  '--setting-sources',
                  '',
                  '--tools',
                  '',
                  '--strict-mcp-config',
                  '--disable-slash-commands',
                  '--no-session-persistence',
                  '--max-turns',
                  '1',
                  // Otherwise newer models run in auto mode, which attaches a
                  // server-side tool use classifier and the user's working
                  // directory, home directory and git state to each request.
                  '--permission-mode',
                  'default',
                  ...(payload.effort ? ['--effort', payload.effort] : []),
                ],
                {
                  cwd: process.cwd(),
                  extendEnv: true,
                  env: {
                    // An API key would silently bill the API instead of the
                    // subscription.
                    ANTHROPIC_API_KEY: undefined,
                    ANTHROPIC_AUTH_TOKEN: undefined,
                    ANTHROPIC_BASE_URL: undefined,
                    // Pi owns retries, compaction and the token budget.
                    CLAUDE_CODE_MAX_RETRIES: '0',
                    DISABLE_AUTO_COMPACT: '1',
                    CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                    CLAUDE_CODE_DISABLE_THINKING:
                      !options.stream?.reasoning &&
                      model.thinkingLevelMap?.off !== null
                        ? '1'
                        : undefined,
                    // The cache anchor must not outlive the breakpoints Claude
                    // Code places in the system prompt before it, so both use
                    // the same TTL.
                    CLAUDE_CODE_PROMPT_CACHE_TTL: cacheTtl,
                    DISABLE_PROMPT_CACHING: cacheTtl === undefined ? '1' : undefined,
                  },
                  // The extra body replaces the matching fields of Claude
                  // Code's own request. It reaches Claude Code as settings
                  // over stdin, because a settings file is limited to 2 MiB
                  // and an environment variable to 128 KiB on Linux.
                  stdin: Stream.make(
                    JSON.stringify({
                      type: 'control_request',
                      request_id: 'extra-body',
                      request: {
                        subtype: 'apply_flag_settings',
                        settings: {
                          env: {
                            CLAUDE_CODE_EXTRA_BODY: JSON.stringify(payload.body),
                          },
                        },
                      },
                    }),
                  ).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        applied.await.pipe(
                          Effect.as(
                            JSON.stringify({
                              type: 'user',
                              message: {
                                role: 'user',
                                content: [{ type: 'text', text: prompt }],
                              },
                            }),
                          ),
                        ),
                      ),
                    ),
                    Stream.map((line) => `${line}\n`),
                    Stream.encodeText,
                  ),
                  forceKillAfter: '3 seconds',
                },
              ),
            )
            .pipe(
              Effect.catchReason('PlatformError', 'NotFound', () =>
                Effect.fail(new ClaudeCliError({ reason: new NotInstalledError() })),
              ),
            )

          const stderrFiber = yield* handle.stderr.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => '',
              (acc, chunk) => String.takeRight(acc + chunk, 4096),
            ),
            Effect.forkScoped,
          )

          const state = yield* handle.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filterMap(
              Filter.fromPredicateOption(Schema.decodeUnknownOption(Line)),
            ),
            Stream.takeUntil(
              (line) =>
                line.type === 'stream_event' && line.event.type === 'message_stop',
            ),
            Stream.runFoldEffect(
              () => ({ stopped: false, result: Option.none<string>() }),
              (previous, line) =>
                Match.value(line).pipe(
                  Match.discriminatorsExhaustive('type')({
                    control_response: ({ response }) =>
                      response.subtype === 'success'
                        ? applied.open.pipe(Effect.as(previous))
                        : Effect.fail(
                            new ClaudeCliError({
                              reason: new RejectedError({ error: response.error }),
                            }),
                          ),
                    result: ({ result }) =>
                      Effect.succeed({
                        ...previous,
                        result: Option.fromNullishOr(result),
                      }),
                    stream_event: ({ event }) =>
                      Effect.sync(() => {
                        options.onEvent(event)
                        return {
                          ...previous,
                          stopped: event.type === 'message_stop',
                        }
                      }),
                  }),
                ),
            ),
          )
          if (state.stopped) {
            return
          }

          const exitCode = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          return yield* new ClaudeCliError({
            reason: pipe(
              state.result,
              Option.filter(
                String.includes('another Claude Code process is refreshing'),
              ),
              Option.match({
                onNone: () =>
                  new NoResponseError({
                    exitCode,
                    result: Option.getOrUndefined(state.result),
                  }),
                onSome: (result) => new LoginBusyError({ result }),
              }),
            ),
            stderr,
          })
        },
        Effect.scoped,
        Effect.catchTag('PlatformError', (cause) =>
          Effect.fail(new ClaudeCliError({ reason: new ProcessError({ cause }) })),
        ),
        // Claude Code fails instead of waiting when another process holds its
        // login refresh lock, and suggests trying again within a minute.
        Effect.retry({
          while: (error) => error.reason._tag === 'LoginBusyError',
          schedule: Schedule.exponential('1 second'),
          times: 6,
        }),
      )

      return { request }
    }),
  },
) {}

export const layer = Layer.effect(
  ClaudeCli,
  Effect.gen(function* () {
    const retention = yield* Config.String('PI_CACHE_RETENTION').pipe(
      Config.withDefault('short'),
    )
    return yield* ClaudeCli.make(retention === 'long' ? 'long' : 'short')
  }),
).pipe(Layer.provide(NodeServices.layer))

/** Pi's `streamSimple` for models of the `claude-cli` provider. */
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

  const applyUsage = (usage: typeof Usage.Type): void => {
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

  const blocks = new Map<number, { contentIndex: number; partialJson: string }>()
  const target = (index: number) =>
    pipe(
      Option.fromUndefinedOr(blocks.get(index)),
      Option.flatMap((entry) =>
        pipe(
          Array.get(output.content, entry.contentIndex),
          Option.map((block) => ({ entry, block })),
        ),
      ),
    )

  const apply = Match.type<Event>().pipe(
    Match.discriminatorsExhaustive('type')({
      message_start: ({ message }) => {
        events.push({ type: 'start', partial: output })
        output.responseId = message.id
        if (message.model !== model.id) {
          output.responseModel = message.model
        }
        applyUsage(message.usage)
      },
      content_block_start: (event) => {
        const contentIndex = output.content.length
        blocks.set(event.index, { contentIndex, partialJson: '' })
        Match.value(event.content_block).pipe(
          Match.discriminatorsExhaustive('type')({
            text: () => {
              output.content.push({ type: 'text', text: '' })
              events.push({ type: 'text_start', contentIndex, partial: output })
            },
            thinking: (block) => {
              output.content.push({
                type: 'thinking',
                thinking: '',
                thinkingSignature: block.signature ?? '',
              })
              events.push({ type: 'thinking_start', contentIndex, partial: output })
            },
            redacted_thinking: (block) => {
              output.content.push({
                type: 'thinking',
                thinking: '[Reasoning redacted]',
                thinkingSignature: block.data,
                redacted: true,
              })
              events.push({ type: 'thinking_start', contentIndex, partial: output })
            },
            tool_use: (block) => {
              output.content.push({
                type: 'toolCall',
                id: block.id,
                name: block.name,
                arguments: {},
              })
              events.push({ type: 'toolcall_start', contentIndex, partial: output })
            },
          }),
        )
      },
      content_block_delta: ({ index, delta }) => {
        Option.map(target(index), ({ entry, block }) => {
          const { contentIndex } = entry
          Match.value(delta).pipe(
            Match.discriminatorsExhaustive('type')({
              text_delta: ({ text }) => {
                if (block.type === 'text') {
                  block.text += text
                  events.push({
                    type: 'text_delta',
                    contentIndex,
                    delta: text,
                    partial: output,
                  })
                }
              },
              thinking_delta: ({ thinking }) => {
                if (block.type === 'thinking') {
                  block.thinking += thinking
                  events.push({
                    type: 'thinking_delta',
                    contentIndex,
                    delta: thinking,
                    partial: output,
                  })
                }
              },
              signature_delta: ({ signature }) => {
                if (block.type === 'thinking') {
                  block.thinkingSignature =
                    (block.thinkingSignature ?? '') + signature
                }
              },
              input_json_delta: ({ partial_json }) => {
                if (block.type === 'toolCall') {
                  entry.partialJson += partial_json
                  block.arguments = parseStreamingJson(entry.partialJson)
                  events.push({
                    type: 'toolcall_delta',
                    contentIndex,
                    delta: partial_json,
                    partial: output,
                  })
                }
              },
            }),
          )
        })
      },
      content_block_stop: ({ index }) => {
        Option.map(target(index), ({ entry, block }) => {
          const { contentIndex } = entry
          Match.value(block).pipe(
            Match.discriminatorsExhaustive('type')({
              text: (text) =>
                events.push({
                  type: 'text_end',
                  contentIndex,
                  content: text.text,
                  partial: output,
                }),
              thinking: (thinking) =>
                events.push({
                  type: 'thinking_end',
                  contentIndex,
                  content: thinking.thinking,
                  partial: output,
                }),
              toolCall: (toolCall) => {
                toolCall.arguments = parseStreamingJson(entry.partialJson)
                events.push({
                  type: 'toolcall_end',
                  contentIndex,
                  toolCall,
                  partial: output,
                })
              },
            }),
          )
        })
      },
      message_delta: ({ delta, usage }) => {
        if (delta.stop_reason) {
          output.rawStopReason = delta.stop_reason
          const stop = Match.value(delta.stop_reason).pipe(
            Match.whenOr('end_turn', 'pause_turn', 'stop_sequence', () => ({
              stopReason: 'stop' as const,
            })),
            Match.when('max_tokens', () => ({ stopReason: 'length' as const })),
            Match.when('tool_use', () => ({ stopReason: 'toolUse' as const })),
            Match.when('refusal', () => ({
              stopReason: 'error' as const,
              errorMessage: 'The model refused to complete the request',
            })),
            // Includes `model_context_window_exceeded`, which pi recognizes as
            // an overflow to compact and retry.
            Match.orElse((reason) => ({
              stopReason: 'error' as const,
              errorMessage: `Unhandled stop reason: ${reason}`,
            })),
          )
          output.stopReason = stop.stopReason
          if ('errorMessage' in stop) {
            output.errorMessage = stop.errorMessage
          }
        }
        if (usage) {
          applyUsage(usage)
        }
      },
      message_stop: () => {
        const reason = output.stopReason
        if (reason !== 'stop' && reason !== 'length' && reason !== 'toolUse') {
          fail(output.errorMessage ?? 'Claude Code ended without a stop reason.')
          return
        }
        settled = true
        events.push({ type: 'done', reason, message: output })
        events.end()
      },
    }),
  )

  void Run.tool(
    Effect.gen(function* () {
      const claudeCli = yield* ClaudeCli
      yield* claudeCli.request({ model, context, stream: options, onEvent: apply })
    }).pipe(Effect.provide(layer)),
    { signal: options?.signal },
  ).catch((error: Error) => fail(error.message))

  return events
}
