import { getAgentDir } from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import {
  Array,
  Clock,
  Config,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Filter,
  Layer,
  Match,
  Option,
  Path,
  pipe,
  Predicate,
  Schema,
  Stream,
  String,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

const STDERR_CAP = 50 * 1024

export const Result = Schema.Struct({
  output: Schema.String,
  toolCalls: Schema.Number,
  usage: Schema.Struct({
    turns: Schema.Number,
    input: Schema.Number,
    output: Schema.Number,
    cacheRead: Schema.Number,
    cacheWrite: Schema.Number,
    cost: Schema.Struct({
      input: Schema.Number,
      output: Schema.Number,
      cacheRead: Schema.Number,
      cacheWrite: Schema.Number,
      total: Schema.Number,
    }),
    contextTokens: Schema.Number,
  }),
  sessionId: Schema.optional(Schema.String),
  durationMs: Schema.optional(Schema.Number),
})

export type Result = typeof Result.Type

export const emptyResult: Result = {
  output: '',
  toolCalls: 0,
  usage: {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    contextTokens: 0,
  },
}

export class StopError extends Schema.TaggedError<StopError>()('StopError', {
  stopReason: Schema.Literals(['error', 'aborted']),
  errorMessage: Schema.optional(Schema.String),
}) {}

export class ExitCodeError extends Schema.TaggedError<ExitCodeError>()(
  'ExitCodeError',
  { exitCode: Schema.Number },
) {}

export class NoOutputError extends Schema.TaggedError<NoOutputError>()(
  'NoOutputError',
  {},
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

export class SubagentError extends Schema.TaggedError<SubagentError>()(
  'SubagentError',
  {
    reason: Schema.Union([StopError, ExitCodeError, NoOutputError, ProcessError]),
    stderr: Schema.optional(Schema.String),
    result: Result,
  },
) {
  override get message(): string {
    const stderr = String.trim(this.stderr ?? '')
    return Match.valueTags(this.reason, {
      StopError: ({ stopReason, errorMessage }) =>
        errorMessage ||
        stderr ||
        this.result.output ||
        `run stopped (${stopReason})`,
      ExitCodeError: ({ exitCode }) =>
        stderr || this.result.output || `pi exited with code ${exitCode}`,
      NoOutputError: () =>
        'Subagent produced no assistant messages (unexpected or empty JSON event stream)' +
        (stderr ? `\nstderr: ${stderr}` : ''),
      ProcessError: (reason) => `Failed to run subagent: ${reason.message}`,
    })
  }
}

const NumberOrZero = Schema.Number.pipe(
  Schema.withDecodingDefault(Effect.succeed(0)),
)

const AssistantMessageEnd = Schema.Struct({
  type: Schema.Literal('message_end'),
  message: Schema.Struct({
    role: Schema.Literal('assistant'),
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
    usage: Schema.Struct({
      input: NumberOrZero,
      output: NumberOrZero,
      cacheRead: NumberOrZero,
      cacheWrite: NumberOrZero,
      totalTokens: Schema.optional(Schema.Number),
      cost: Schema.Struct({
        input: NumberOrZero,
        output: NumberOrZero,
        cacheRead: NumberOrZero,
        cacheWrite: NumberOrZero,
        total: NumberOrZero,
      }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    }).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
})

const Event = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal('session'), id: Schema.String }),
    AssistantMessageEnd,
  ]),
)

type State = {
  readonly result: Result
  readonly stopReason?: string | undefined
  readonly errorMessage?: string | undefined
}

function foldMessage(
  state: State,
  message: (typeof AssistantMessageEnd.Type)['message'],
): State {
  const { result } = state
  const { usage } = message
  const text = pipe(
    message.content,
    Array.flatMap((part) =>
      part.type === 'text' && part.text !== undefined ? [part.text] : [],
    ),
    Array.join('\n\n'),
    String.trim,
  )
  return {
    result: {
      ...result,
      output: String.isNonEmpty(text) ? text : result.output,
      toolCalls:
        result.toolCalls +
        Array.countBy(message.content, (part) => part.type === 'toolCall'),
      usage: {
        turns: result.usage.turns + 1,
        input: result.usage.input + usage.input,
        output: result.usage.output + usage.output,
        cacheRead: result.usage.cacheRead + usage.cacheRead,
        cacheWrite: result.usage.cacheWrite + usage.cacheWrite,
        cost: {
          input: result.usage.cost.input + usage.cost.input,
          output: result.usage.cost.output + usage.cost.output,
          cacheRead: result.usage.cost.cacheRead + usage.cost.cacheRead,
          cacheWrite: result.usage.cost.cacheWrite + usage.cost.cacheWrite,
          total: result.usage.cost.total + usage.cost.total,
        },
        contextTokens: usage.totalTokens ?? result.usage.contextTokens,
      },
    },
    stopReason: message.stopReason ?? state.stopReason,
    errorMessage: message.errorMessage ?? state.errorMessage,
  }
}

export class Subagent extends Context.Service<Subagent>()(
  '@pi-plugins/subagent/Subagent',
  {
    make: Effect.fnUntraced(function* (sessionDir: string) {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const run = Effect.fn('Subagent.run')(
        function* (options: {
          readonly prompt: string
          readonly name?: string | undefined
          readonly model?: string | undefined
          readonly cwd?: string | undefined
          readonly tools?: ReadonlyArray<string> | undefined
          readonly onSession?: ((sessionId: string) => void) | undefined
        }) {
          // `--exclude-tools subagent` keeps children from spawning their own.
          const args = [
            '--mode',
            'json',
            '-p',
            '--session-dir',
            sessionDir,
            '--exclude-tools',
            'subagent',
          ]
          // pi exits on an empty --name.
          const name = pipe(
            Option.fromUndefinedOr(options.name),
            Option.map(String.trim),
            Option.filter(String.isNonEmpty),
          )
          if (Option.isSome(name)) {
            args.push('--name', name.value)
          }
          if (options.tools !== undefined) {
            if (Array.isReadonlyArrayNonEmpty(options.tools)) {
              args.push('--tools', Array.join(options.tools, ','))
            } else {
              args.push('--no-tools')
            }
          }
          if (options.model !== undefined) {
            args.push('--model', options.model)
          }

          // Re-invoke the running harness: the entry script via the current runtime,
          // the executable itself for compiled binaries, or `pi` on PATH.
          const script = process.argv[1]
          const execName = String.toLowerCase(path.basename(process.execPath))
          const invocation =
            script &&
            !String.startsWith('/$bunfs/root/')(script) &&
            (yield* fs.exists(script).pipe(Effect.orElseSucceed(() => false)))
              ? { command: process.execPath, args: [script, ...args] }
              : /^(node|bun)(\.exe)?$/.test(execName)
                ? { command: 'pi', args }
                : { command: process.execPath, args }

          const startedAt = yield* Clock.currentTimeMillis
          const handle = yield* spawner.spawn(
            ChildProcess.make(invocation.command, invocation.args, {
              cwd: options.cwd,
              // Overrides a process-wide long retention setting.
              env: { PI_CACHE_RETENTION: 'short' },
              extendEnv: true,
              stdin: Stream.make(options.prompt).pipe(Stream.encodeText),
              forceKillAfter: '5 seconds',
            }),
          )

          const stderrFiber = yield* handle.stderr.pipe(
            Stream.decodeText,
            Stream.runFold(
              () => '',
              (acc, chunk) =>
                acc.length >= STDERR_CAP
                  ? acc
                  : acc + String.takeLeft(chunk, STDERR_CAP - acc.length),
            ),
            Effect.forkScoped,
          )

          const state = yield* handle.stdout.pipe(
            Stream.decodeText,
            Stream.splitLines,
            Stream.filterMap(
              Filter.fromPredicateOption(Schema.decodeUnknownOption(Event)),
            ),
            Stream.runFoldEffect(
              (): State => ({ result: emptyResult }),
              (previous, event) =>
                Effect.sync(() => {
                  if (event.type === 'session') {
                    // A second header would cost the caller an extra render.
                    if (previous.result.sessionId !== undefined) {
                      return previous
                    }
                    options.onSession?.(event.id)
                    return {
                      ...previous,
                      result: { ...previous.result, sessionId: event.id },
                    }
                  }
                  return foldMessage(previous, event.message)
                }),
            ),
          )

          const exitCode = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)
          const result = {
            ...state.result,
            durationMs: (yield* Clock.currentTimeMillis) - startedAt,
          }

          if (state.stopReason === 'error' || state.stopReason === 'aborted') {
            return yield* new SubagentError({
              reason: new StopError({
                stopReason: state.stopReason,
                errorMessage: state.errorMessage,
              }),
              stderr,
              result,
            })
          }
          if (exitCode !== 0) {
            return yield* new SubagentError({
              reason: new ExitCodeError({ exitCode }),
              stderr,
              result,
            })
          }
          if (result.usage.turns === 0) {
            return yield* new SubagentError({
              reason: new NoOutputError(),
              stderr,
              result,
            })
          }

          return result
        },
        Effect.scoped,
        Effect.catchTag('PlatformError', (cause) =>
          Effect.fail(
            new SubagentError({
              reason: new ProcessError({ cause }),
              result: emptyResult,
            }),
          ),
        ),
      )

      return { run }
    }),
  },
) {}

export const layer = Layer.effect(
  Subagent,
  Effect.gen(function* () {
    const path = yield* Path.Path
    const configured = yield* Config.String('PI_SUBAGENT_SESSION_DIR').pipe(
      Config.withDefault(''),
    )
    // Beside pi's per-project `--<cwd>--` directories, so child sessions stay
    // out of `pi -c` / `pi -r` but resolve by id from anywhere.
    const sessionDir = String.isNonEmpty(configured)
      ? path.resolve(configured)
      : path.join(getAgentDir(), 'sessions', 'subagents')
    return yield* Subagent.make(sessionDir)
  }),
).pipe(Layer.provide(NodeServices.layer))
