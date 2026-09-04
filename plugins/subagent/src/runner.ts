import * as fs from 'node:fs'
import * as path from 'node:path'
import { Data, Effect, Fiber, Filter, Schema, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

const STDERR_CAP = 50 * 1024
const FORCE_KILL_AFTER = '5 seconds'

export interface SubagentUsage {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
}

export interface SubagentResult {
  output: string
  toolCalls: number
  usage: SubagentUsage
  sessionId?: string | undefined
  durationMs?: number | undefined
}

export const emptyResult: SubagentResult = {
  output: '',
  toolCalls: 0,
  usage: {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
  },
}

export class SubagentStopError extends Data.TaggedError('SubagentStopError')<{
  readonly reason: 'error' | 'aborted'
  readonly errorMessage?: string | undefined
  readonly stderr: string
  readonly result: SubagentResult
}> {
  override readonly message: string =
    this.errorMessage ||
    this.stderr.trim() ||
    this.result.output ||
    `run stopped (${this.reason})`
}

export class SubagentExitError extends Data.TaggedError('SubagentExitError')<{
  readonly exitCode: number
  readonly stderr: string
  readonly result: SubagentResult
}> {
  override readonly message: string =
    this.stderr.trim() ||
    this.result.output ||
    `pi exited with code ${this.exitCode}`
}

export class SubagentNoOutputError extends Data.TaggedError(
  'SubagentNoOutputError',
)<{
  readonly stderr: string
  readonly result: SubagentResult
}> {
  override readonly message: string =
    'Subagent produced no assistant messages (unexpected or empty JSON event stream)' +
    (this.stderr.trim() ? `\nstderr: ${this.stderr.trim()}` : '')
}

const SessionHeader = Schema.Struct({
  type: Schema.Literal('session'),
  id: Schema.String,
})

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
    usage: Schema.optional(
      Schema.Struct({
        input: Schema.optional(Schema.Number),
        output: Schema.optional(Schema.Number),
        cacheRead: Schema.optional(Schema.Number),
        cacheWrite: Schema.optional(Schema.Number),
        totalTokens: Schema.optional(Schema.Number),
        cost: Schema.optional(
          Schema.Struct({ total: Schema.optional(Schema.Number) }),
        ),
      }),
    ),
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
  }),
})

const SubagentEvent = Schema.fromJsonString(
  Schema.Union([SessionHeader, AssistantMessageEnd]),
)

interface RunState {
  result: SubagentResult
  stopReason?: string | undefined
  errorMessage?: string | undefined
}

export function runSubagent(options: {
  prompt: string
  sessionDir: string
  name?: string | undefined
  model?: string | undefined
  cwd?: string | undefined
  tools?: ReadonlyArray<string> | undefined
  onSession?: ((sessionId: string) => void) | undefined
}): Effect.Effect<
  SubagentResult,
  SubagentStopError | SubagentExitError | SubagentNoOutputError | PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `--exclude-tools subagent` keeps children from spawning their own.
      const args = [
        '--mode',
        'json',
        '-p',
        '--session-dir',
        options.sessionDir,
        '--exclude-tools',
        'subagent',
      ]
      // pi exits on an empty --name.
      const name = options.name?.trim()
      if (name) {
        args.push('--name', name)
      }
      if (options.tools !== undefined) {
        if (options.tools.length > 0) {
          args.push('--tools', options.tools.join(','))
        } else {
          args.push('--no-tools')
        }
      }
      if (options.model !== undefined) {
        args.push('--model', options.model)
      }

      // Re-invoke the running harness: the entry script via the current runtime,
      // the executable itself for compiled binaries, or `pi` on PATH.
      const currentScript = process.argv[1]
      const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
      const execName = path.basename(process.execPath).toLowerCase()
      const invocation =
        currentScript && !isBunVirtualScript && fs.existsSync(currentScript)
          ? { command: process.execPath, args: [currentScript, ...args] }
          : /^(node|bun)(\.exe)?$/.test(execName)
            ? { command: 'pi', args }
            : { command: process.execPath, args }

      const startedAt = Date.now()
      const handle = yield* ChildProcess.make(invocation.command, invocation.args, {
        cwd: options.cwd,
        // Overrides a process-wide long retention setting; the explicit value
        // also tells @pi-plugins/claude-oauth not to extend child TTLs.
        env: { PI_CACHE_RETENTION: 'short' },
        extendEnv: true,
        stdin: Stream.make(new TextEncoder().encode(options.prompt)),
        forceKillAfter: FORCE_KILL_AFTER,
      })

      const stderrFiber = yield* Effect.forkScoped(
        handle.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => '',
            (acc, chunk) =>
              acc.length >= STDERR_CAP
                ? acc
                : acc + chunk.slice(0, STDERR_CAP - acc.length),
          ),
        ),
      )

      const state = yield* handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filterMap(
          Filter.fromPredicateOption(Schema.decodeUnknownOption(SubagentEvent)),
        ),
        Stream.runFoldEffect(
          (): RunState => ({ result: emptyResult }),
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

              const { result } = previous
              const { message } = event
              let toolCalls = result.toolCalls
              const texts: string[] = []
              for (const part of message.content) {
                if (part.type === 'text' && part.text !== undefined) {
                  texts.push(part.text)
                } else if (part.type === 'toolCall') {
                  toolCalls += 1
                }
              }
              const text = texts.join('\n\n').trim()
              const usage = message.usage
              return {
                result: {
                  ...result,
                  output: text.length > 0 ? text : result.output,
                  toolCalls,
                  usage: {
                    turns: result.usage.turns + 1,
                    input: result.usage.input + (usage?.input ?? 0),
                    output: result.usage.output + (usage?.output ?? 0),
                    cacheRead: result.usage.cacheRead + (usage?.cacheRead ?? 0),
                    cacheWrite: result.usage.cacheWrite + (usage?.cacheWrite ?? 0),
                    cost: result.usage.cost + (usage?.cost?.total ?? 0),
                    contextTokens: usage?.totalTokens ?? result.usage.contextTokens,
                  },
                },
                stopReason: message.stopReason ?? previous.stopReason,
                errorMessage: message.errorMessage ?? previous.errorMessage,
              }
            }),
        ),
      )

      const exitCode = Number(yield* handle.exitCode)
      const stderr = yield* Fiber.join(stderrFiber)
      const result = { ...state.result, durationMs: Date.now() - startedAt }

      if (state.stopReason === 'error' || state.stopReason === 'aborted') {
        return yield* new SubagentStopError({
          reason: state.stopReason,
          errorMessage: state.errorMessage,
          stderr,
          result,
        })
      }
      if (exitCode !== 0) {
        return yield* new SubagentExitError({ exitCode, stderr, result })
      }
      if (result.usage.turns === 0) {
        return yield* new SubagentNoOutputError({ stderr, result })
      }

      return result
    }),
  )
}
