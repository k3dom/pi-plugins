import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
// Pi provides extensions only some of pi-ai's entry points, which include
// `compat` but not `api/anthropic-messages`.
import * as PiAi from '@earendil-works/pi-ai/compat'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Array,
  Cause,
  Config,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Filter,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Path,
  pipe,
  Predicate,
  Queue,
  Record,
  Schedule,
  Schema,
  Stream,
  String,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

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

export class AbortedError extends Schema.TaggedError<AbortedError>()(
  'AbortedError',
  {},
) {}

export class NoResponseError extends Schema.TaggedError<NoResponseError>()(
  'NoResponseError',
  {
    exitCode: Schema.optional(Schema.Number),
    result: Schema.optional(Schema.String),
  },
) {}

export class UsageCreditsChargedError extends Schema.TaggedError<UsageCreditsChargedError>()(
  'UsageCreditsChargedError',
  {},
) {}

export class UsageCreditsRequiredError extends Schema.TaggedError<UsageCreditsRequiredError>()(
  'UsageCreditsRequiredError',
  { result: Schema.String },
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
      AbortedError,
      NoResponseError,
      UsageCreditsChargedError,
      UsageCreditsRequiredError,
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
      // What pi's Anthropic provider reports for an aborted request, which pi
      // shows as an abort rather than an error.
      AbortedError: () => 'Request was aborted',
      NoResponseError: ({ exitCode, result }) =>
        result ||
        String.trim(this.stderr ?? '') ||
        `Claude Code exited with code ${exitCode}.`,
      // Pi does not retry errors that mention billing.
      UsageCreditsChargedError: () =>
        'Claude Code charged this response to your Claude usage credits instead of your plan limits, so pi stopped to avoid further billing. To stay on your plan limits, turn off usage credits at claude.ai/settings/usage. To keep using credits, set PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1 and restart pi.',
      UsageCreditsRequiredError: ({ result }) =>
        `Anthropic did not accept this request on your plan limits and would charge it to your Claude usage credits instead. This happens once a plan limit is used up, or when Anthropic counts the request as use by a third-party app. Wait for the limit to reset, or check your usage and billing at claude.ai/settings/usage. Claude Code said: ${result}`,
      ProcessError: (reason) => `Failed to run Claude Code: ${reason.message}`,
    })
  }
}

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

const CacheControl = Schema.Struct({
  ttl: Schema.optional(Schema.Literals(['5m', '1h'])),
})

const Block = Schema.Struct({
  type: Schema.String,
  text: Schema.optional(Schema.String),
  cache_control: Schema.optional(CacheControl),
})

const Content = Schema.Union([Schema.String, Schema.Array(Block)])

const blocks = (content: typeof Content.Type) =>
  Predicate.isString(content) ? [{ type: 'text', text: content }] : content

// The parts of the request parameters that decide how Claude Code runs.
const Params = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.optional(
    Schema.Array(Schema.Struct({ cache_control: Schema.optional(CacheControl) })),
  ),
  thinking: Schema.optional(Schema.Struct({ type: Schema.String })),
})

const Line = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal('stream_event'),
      event: Schema.StructWithRest(Schema.Struct({ type: Schema.String }), [
        Schema.Record(Schema.String, Schema.Unknown),
      ]),
    }),
    Schema.Struct({
      type: Schema.Literal('control_response'),
      response: Schema.Union([
        Schema.Struct({ subtype: Schema.Literal('success') }),
        Schema.Struct({ subtype: Schema.Literal('error'), error: Schema.String }),
      ]),
    }),
    Schema.Struct({
      type: Schema.Literal('rate_limit_event'),
      rate_limit_info: Schema.Struct({
        isUsingOverage: Schema.optional(Schema.Boolean),
      }),
    }),
    Schema.Struct({
      type: Schema.Literal('result'),
      result: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ]),
)

const SessionId = Schema.String.check(Schema.isUUID())

export class ClaudeCli extends Context.Service<ClaudeCli>()(
  '@pi-plugins/claude-cli/ClaudeCli',
  {
    make: Effect.fnUntraced(function* (config: {
      readonly allowUsageCredits: boolean
    }) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const run = Effect.fnUntraced(function* (options: {
        readonly model: string
        readonly body: unknown
        readonly betas: Option.Option<string>
        readonly sessionId: Option.Option<string>
      }) {
        const body = yield* Schema.decodeUnknownEffect(Body)(options.body).pipe(
          Effect.orDie,
        )
        const params = yield* Schema.decodeUnknownEffect(Params)(body).pipe(
          Effect.orDie,
        )
        const system: ReadonlyArray<typeof Block.Type> = pipe(
          Option.fromNullishOr(params.system),
          Option.map(blocks),
          Option.getOrElse(() => []),
        )
        const sessionId = Option.filter(options.sessionId, Schema.is(SessionId))

        // The cache breakpoints Claude Code places in the system prompt come
        // before pi's, and a breakpoint must not outlive one before it, so
        // both use pi's TTL.
        const cacheTtl = pipe(
          [
            ...system,
            ...(params.tools ?? []),
            ...Array.flatMap(params.messages, (message) => blocks(message.content)),
          ],
          Array.findFirst((block) => Option.fromNullishOr(block.cache_control)),
          Option.map((cacheControl) => cacheControl.ttl ?? '5m'),
        )

        // Claude Code's billing header carries a fingerprint of the first
        // user message, so it gets pi's.
        const prompt = pipe(
          params.messages,
          Array.findFirst((message) =>
            message.role === 'user' ? Option.some(message.content) : Option.none(),
          ),
          Option.flatMap((content) =>
            Array.findFirst(blocks(content), (block) =>
              block.type === 'text'
                ? Option.fromNullishOr(block.text)
                : Option.none(),
            ),
          ),
          Option.filter(String.isNonEmpty),
          Option.getOrElse(() => '.'),
        )

        const systemPrompt = pipe(
          system,
          Array.flatMapNullishOr(({ text }) => text),
          Array.join('\n\n'),
        )

        // A file rather than an argument, which is limited to 128 KiB on
        // Linux. Claude Code puts its billing header and identity before it.
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: 'pi-claude-cli-' })
        const systemPromptFile = path.join(dir, 'system-prompt.md')
        yield* fs.writeFileString(systemPromptFile, systemPrompt)

        const input = yield* Queue.make<string, Cause.Done>()
        const claude = yield* spawner
          .spawn(
            ChildProcess.make(
              'claude',
              [
                '--print',
                '--model',
                options.model,
                '--input-format',
                'stream-json',
                '--output-format',
                'stream-json',
                '--verbose',
                '--include-partial-messages',
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
                // All requests of a pi session form one Claude Code session, as
                // they would in Claude Code itself.
                ...Option.match(sessionId, {
                  onNone: () => [],
                  onSome: (id) => ['--session-id', id],
                }),
                '--system-prompt-file',
                systemPromptFile,
              ],
              {
                // Inherits pi's working directory. Node caches
                // `process.cwd()`, which still names the old path after the
                // directory is moved.
                extendEnv: true,
                env: {
                  // An API key would silently bill the API instead of the
                  // subscription.
                  ANTHROPIC_API_KEY: undefined,
                  ANTHROPIC_AUTH_TOKEN: undefined,
                  ANTHROPIC_BASE_URL: undefined,
                  ANTHROPIC_BETAS: Option.getOrUndefined(options.betas),
                  // Pi owns retries, compaction and the token budget.
                  CLAUDE_CODE_MAX_RETRIES: '0',
                  DISABLE_AUTO_COMPACT: '1',
                  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                  CLAUDE_CODE_DISABLE_THINKING:
                    params.thinking?.type === 'disabled' ? '1' : undefined,
                  CLAUDE_CODE_PROMPT_CACHE_TTL: Option.getOrUndefined(cacheTtl),
                  DISABLE_PROMPT_CACHING: Option.isNone(cacheTtl) ? '1' : undefined,
                },
                stdin: Stream.fromQueue(input).pipe(
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
        const stderrTail = yield* claude.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => '',
            (acc, chunk) => String.takeRight(acc + chunk, 4096),
          ),
          Effect.forkScoped,
        )

        // The rest of pi's request replaces the matching fields of Claude
        // Code's own. It reaches Claude Code as settings over stdin, because
        // a settings file is limited to 2 MiB and an environment variable to
        // 128 KiB on Linux.
        yield* Queue.offer(
          input,
          JSON.stringify({
            type: 'control_request',
            request_id: 'extra-body',
            request: {
              subtype: 'apply_flag_settings',
              settings: {
                env: {
                  CLAUDE_CODE_EXTRA_BODY: JSON.stringify(
                    pipe(
                      body,
                      Record.remove('model'),
                      Record.remove('system'),
                      Record.remove('stream'),
                      Record.remove('metadata'),
                    ),
                  ),
                },
              },
            },
          }),
        )

        return claude.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filterMap(
            Filter.fromPredicateOption(Schema.decodeUnknownOption(Line)),
          ),
          // Claude Code reports which limits paid for the response only after
          // its `message_stop`, so that is held back until the report or the
          // result.
          Stream.mapAccumEffect(
            Option.none<
              Extract<typeof Line.Type, { readonly type: 'stream_event' }>['event']
            >,
            (stop, line) =>
              Match.value(line).pipe(
                Match.discriminatorsExhaustive('type')({
                  // The prompt follows only once Claude Code has applied pi's
                  // request body, so it never answers the prompt without pi's
                  // conversation.
                  control_response: Effect.fnUntraced(function* ({ response }) {
                    if (response.subtype === 'error') {
                      return yield* new ClaudeCliError({
                        reason: new RejectedError({ error: response.error }),
                      })
                    }
                    yield* Queue.offer(
                      input,
                      JSON.stringify({
                        type: 'user',
                        message: {
                          role: 'user',
                          content: [{ type: 'text', text: prompt }],
                        },
                      }),
                    )
                    yield* Queue.end(input)
                    return [stop, []] as const
                  }),
                  stream_event: ({ event }) =>
                    Effect.succeed(
                      Option.match(stop, {
                        onSome: () => [stop, []] as const,
                        onNone: () =>
                          event.type === 'message_stop'
                            ? ([Option.some(event), []] as const)
                            : ([stop, [event]] as const),
                      }),
                    ),
                  rate_limit_event: Effect.fnUntraced(function* ({
                    rate_limit_info,
                  }) {
                    if (
                      rate_limit_info.isUsingOverage === true &&
                      !config.allowUsageCredits
                    ) {
                      return yield* new ClaudeCliError({
                        reason: new UsageCreditsChargedError(),
                      })
                    }
                    return [stop, Array.fromOption(stop)] as const
                  }),
                  // A result before the response means there is none.
                  result: Effect.fnUntraced(function* ({ result: text }) {
                    if (Option.isSome(stop) || !text) {
                      return [stop, Array.fromOption(stop)] as const
                    }
                    return yield* new ClaudeCliError({
                      reason: Match.value(text).pipe(
                        Match.when(
                          String.includes(
                            'another Claude Code process is refreshing',
                          ),
                          (result) => new LoginBusyError({ result }),
                        ),
                        Match.when(
                          (result) =>
                            /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i.test(
                              result,
                            ),
                          (result) => new UsageCreditsRequiredError({ result }),
                        ),
                        Match.orElse((result) => new NoResponseError({ result })),
                      ),
                    })
                  }),
                }),
              ),
            { onHalt: Array.fromOption },
          ),
          // Only reached when Claude Code ends before a response or a result.
          Stream.concat(
            Stream.fromEffect(
              Effect.gen(function* () {
                const exitCode = yield* claude.exitCode
                return yield* new ClaudeCliError({
                  reason: new NoResponseError({ exitCode }),
                  stderr: yield* Fiber.join(stderrTail),
                })
              }),
            ),
          ),
          Stream.takeUntil((event) => event.type === 'message_stop'),
          Stream.map(
            (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
          Stream.encodeText,
        )
      })

      // Runs one Messages API request from pi's Anthropic provider through
      // one `claude --print` process and streams the response as server-sent
      // events up to the first `message_stop`. The process is stopped once
      // Claude Code has reported the limits that paid for the response, before
      // it can send another request.
      const request = (options: Parameters<typeof run>[0]) =>
        Stream.unwrap(run(options)).pipe(
          Stream.catchTag('PlatformError', (cause) =>
            Stream.fail(new ClaudeCliError({ reason: new ProcessError({ cause }) })),
          ),
          // Claude Code fails instead of waiting when another process holds
          // its login refresh lock, and suggests trying again within a minute.
          Stream.retry(($) =>
            $(Schedule.exponential('1 second')).pipe(
              Schedule.upTo({ times: 6 }),
              Schedule.while(({ input }) => input.reason._tag === 'LoginBusyError'),
            ),
          ),
          Stream.withSpan('ClaudeCli.request'),
        )

      return { request }
    }),
  },
) {}

export const layer = Layer.effect(
  ClaudeCli,
  Effect.gen(function* () {
    const allowUsageCredits = yield* Config.Boolean(
      'PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS',
    ).pipe(Config.withDefault(false))
    return yield* ClaudeCli.make({ allowUsageCredits })
  }),
).pipe(Layer.provide(NodeServices.layer))

const runtime = ManagedRuntime.make(layer)

/**
 * Pi's `streamSimple` for models of the `claude-cli` provider. Pi's Anthropic
 * provider builds the request and reads the response, as it does for the
 * `anthropic` provider, and Claude Code sends the request in between.
 */
export function stream(
  model: Model<Api>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  return PiAi.anthropicMessagesApi().streamSimple(
    {
      ...model,
      api: 'anthropic-messages',
      compat: model.compat as AnthropicMessagesCompat | undefined,
    },
    context,
    {
      ...options,
      // Never leaves the process. Claude Code signs the request itself.
      apiKey: 'claude-cli',
      fetch: async (_input, init) => {
        const signal = init?.signal
        const events = Stream.unwrap(
          Effect.gen(function* () {
            const claudeCli = yield* ClaudeCli
            return claudeCli.request({
              model: model.contextWindow >= 1_000_000 ? `${model.id}[1m]` : model.id,
              body: init?.body,
              betas: Option.fromNullishOr(
                new Headers(init?.headers).get('anthropic-beta'),
              ),
              sessionId: Option.fromNullishOr(options?.sessionId),
            })
          }),
        ).pipe(
          // Pi stops reading the response when aborted but does not cancel it.
          Stream.interruptWhen(
            Effect.callback<never, ClaudeCliError>((resume) => {
              const abort = () =>
                resume(
                  Effect.fail(new ClaudeCliError({ reason: new AbortedError() })),
                )
              if (signal?.aborted) {
                abort()
              }
              signal?.addEventListener('abort', abort, { once: true })
              return Effect.sync(() => signal?.removeEventListener('abort', abort))
            }),
          ),
        )
        return new Response(
          Stream.toReadableStreamWith(events, await runtime.context(), {
            // Reads Claude Code's response to the end even when pi stops
            // reading early without aborting, so the process is always
            // stopped.
            strategy: new CountQueuingStrategy({ highWaterMark: Infinity }),
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    },
  )
}
