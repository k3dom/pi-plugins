import type {
  AnthropicMessagesCompat,
  Api,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from '@earendil-works/pi-ai'
import * as AnthropicMessages from '@earendil-works/pi-ai/api/anthropic-messages'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Array,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Filter,
  Latch,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Path,
  pipe,
  Predicate,
  Record,
  Result,
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

export class NoResponseError extends Schema.TaggedError<NoResponseError>()(
  'NoResponseError',
  {
    exitCode: Schema.optional(Schema.Number),
    result: Schema.optional(Schema.String),
  },
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

// The parts of the request that decide how Claude Code runs.
const Request = Schema.Struct({
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
      type: Schema.Literal('result'),
      result: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ]),
)

export class ClaudeCli extends Context.Service<ClaudeCli>()(
  '@pi-plugins/claude-cli/ClaudeCli',
  {
    make: Effect.fnUntraced(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const run = Effect.fnUntraced(function* (options: {
        readonly model: string
        readonly body: unknown
        readonly betas: Option.Option<string>
      }) {
        const body = yield* Schema.decodeUnknownEffect(Body)(options.body).pipe(
          Effect.orDie,
        )
        const request = yield* Schema.decodeUnknownEffect(Request)(body).pipe(
          Effect.orDie,
        )
        // A file rather than an argument, which is limited to 128 KiB on
        // Linux. Claude Code puts its billing header and identity before it.
        const dir = yield* fs.makeTempDirectoryScoped({
          prefix: 'pi-claude-cli-',
        })
        const systemPromptFile = path.join(dir, 'system-prompt.md')
        yield* fs.writeFileString(
          systemPromptFile,
          pipe(
            Option.fromNullishOr(request.system),
            Option.map(blocks),
            Option.getOrElse(() => []),
            Array.flatMap(({ text }) => (text === undefined ? [] : [text])),
            Array.join('\n\n'),
          ),
        )

        // The cache breakpoints Claude Code places in the system prompt come
        // before pi's, and a breakpoint must not outlive one before it, so
        // both use pi's TTL.
        const cacheTtl = pipe(
          [
            ...pipe(
              Option.fromNullishOr(request.system),
              Option.map(blocks),
              Option.getOrElse(() => []),
            ),
            ...(request.tools ?? []),
            ...Array.flatMap(request.messages, (message) => blocks(message.content)),
          ],
          Array.findFirst((block) => Option.fromNullishOr(block.cache_control)),
          Option.map((cacheControl) => cacheControl.ttl ?? '5m'),
        )

        // Claude Code's billing header carries a fingerprint of the first
        // user message, so it gets pi's.
        const prompt = pipe(
          request.messages,
          Array.findFirst((message) =>
            message.role === 'user' ? Option.some(message.content) : Option.none(),
          ),
          Option.flatMap((content) =>
            Predicate.isString(content)
              ? Option.some(content)
              : Array.findFirst(content, (block) =>
                  block.type === 'text'
                    ? Option.fromNullishOr(block.text)
                    : Option.none(),
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
                options.model,
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
                  ANTHROPIC_BETAS: Option.getOrUndefined(options.betas),
                  // Pi owns retries, compaction and the token budget.
                  CLAUDE_CODE_MAX_RETRIES: '0',
                  DISABLE_AUTO_COMPACT: '1',
                  CLAUDE_CODE_TOTAL_TOKENS_REMINDER: 'off',
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
                  CLAUDE_CODE_DISABLE_THINKING:
                    request.thinking?.type === 'disabled' ? '1' : undefined,
                  CLAUDE_CODE_PROMPT_CACHE_TTL: Option.getOrUndefined(cacheTtl),
                  DISABLE_PROMPT_CACHING: Option.isNone(cacheTtl) ? '1' : undefined,
                },
                // The rest of pi's request replaces the matching fields of
                // Claude Code's own. It reaches Claude Code as settings over
                // stdin, because a settings file is limited to 2 MiB and an
                // environment variable to 128 KiB on Linux.
                stdin: Stream.make(
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

        return handle.stdout.pipe(
          Stream.decodeText,
          Stream.splitLines,
          Stream.filterMap(
            Filter.fromPredicateOption(Schema.decodeUnknownOption(Line)),
          ),
          // Only reached when Claude Code ends before a response or a result.
          Stream.concat(
            Stream.fromEffect(
              Effect.gen(function* () {
                const exitCode = yield* handle.exitCode
                return yield* new ClaudeCliError({
                  reason: new NoResponseError({ exitCode }),
                  stderr: yield* Fiber.join(stderrFiber),
                })
              }),
            ),
          ),
          Stream.takeUntil(
            (line) =>
              line.type === 'stream_event' && line.event.type === 'message_stop',
          ),
          Stream.filterMapEffect((line) =>
            Match.value(line).pipe(
              Match.discriminatorsExhaustive('type')({
                control_response: ({ response }) =>
                  response.subtype === 'success'
                    ? applied.open.pipe(Effect.as(Result.failVoid))
                    : Effect.fail(
                        new ClaudeCliError({
                          reason: new RejectedError({ error: response.error }),
                        }),
                      ),
                // A result before the response means there is none.
                result: ({ result: text }) =>
                  pipe(
                    Option.fromNullishOr(text),
                    Option.filter(String.isNonEmpty),
                    Option.match({
                      onNone: () => Effect.succeed(Result.failVoid),
                      onSome: (result) =>
                        Effect.fail(
                          new ClaudeCliError({
                            reason: String.includes(
                              'another Claude Code process is refreshing',
                            )(result)
                              ? new LoginBusyError({ result })
                              : new NoResponseError({ result }),
                          }),
                        ),
                    }),
                  ),
                stream_event: ({ event }) => Effect.succeed(Result.succeed(event)),
              }),
            ),
          ),
          Stream.map(
            (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
          ),
          Stream.encodeText,
        )
      })

      // Runs one Messages API request from pi's Anthropic provider through
      // one `claude --print` process and streams the response as server-sent
      // events up to the first `message_stop`. The process is stopped there,
      // before Claude Code can act on the response.
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

export const layer = Layer.effect(ClaudeCli, ClaudeCli.make()).pipe(
  Layer.provide(NodeServices.layer),
)

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
  return AnthropicMessages.streamSimple(
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
            })
          }),
        ).pipe(
          // Pi stops reading the response when aborted but does not cancel it.
          Stream.interruptWhen(
            Effect.callback<void>((resume) => {
              const abort = () => resume(Effect.void)
              if (signal?.aborted) {
                abort()
              }
              signal?.addEventListener('abort', abort, { once: true })
              return Effect.sync(() => signal?.removeEventListener('abort', abort))
            }),
          ),
        )
        return new Response(
          Stream.toReadableStreamWith(events, await runtime.context()),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    },
  )
}
