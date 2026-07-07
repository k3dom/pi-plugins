import * as fs from 'node:fs'
import * as path from 'node:path'
import { Effect, Fiber, Filter, Schema, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/** Cap on buffered stderr (in characters) so a pathological child can't exhaust memory. */
const STDERR_CAP = 50 * 1024

/** Grace period between SIGTERM and SIGKILL when terminating the child. */
const FORCE_KILL_AFTER = '5 seconds'

/** Aggregated token/cost statistics across all turns of a subagent run. */
export interface SubagentUsage {
  turns: number
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  contextTokens: number
}

/** Live progress of a running subagent, emitted after every completed message. */
export interface SubagentSnapshot {
  /** Text of the most recent assistant message. */
  output: string
  toolCalls: number
  usage: SubagentUsage
  model?: string | undefined
  stopReason?: string | undefined
  errorMessage?: string | undefined
}

/** Final outcome of a subagent run. */
export interface SubagentResult extends SubagentSnapshot {
  exitCode: number
  stderr: string
}

export interface RunSubagentOptions {
  prompt: string
  /** Optional model override, passed to `pi --model`. */
  model?: string | undefined
  /** Working directory for the spawned pi process. */
  cwd?: string | undefined
  /** Tool allowlist for the child. */
  tools?: ReadonlyArray<string> | undefined
  /** Called with a fresh snapshot whenever the subagent completes a message. */
  onUpdate?: ((snapshot: SubagentSnapshot) => void) | undefined
}

/**
 * The `--mode json` event lines we care about (see pi docs/json.md): completed
 * assistant messages.
 */
const AssistantMessageEnd = Schema.fromJsonString(
  Schema.Struct({
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
      model: Schema.optional(Schema.String),
      stopReason: Schema.optional(Schema.String),
      errorMessage: Schema.optional(Schema.String),
    }),
  }),
)

type AssistantMessage = (typeof AssistantMessageEnd)['Type']['message']

const initialSnapshot: SubagentSnapshot = {
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

/** Folds one completed assistant message into the snapshot. */
function foldMessage(
  snapshot: SubagentSnapshot,
  message: AssistantMessage,
): SubagentSnapshot {
  let toolCalls = snapshot.toolCalls
  const texts: string[] = []
  for (const part of message.content) {
    if (part.type === 'text' && part.text !== undefined) {
      texts.push(part.text)
    } else if (part.type === 'toolCall') {
      toolCalls += 1
    }
  }
  const text = texts.join('\n\n').trim()
  const output = text.length > 0 ? text : snapshot.output

  const usage = message.usage
  return {
    output,
    toolCalls,
    usage: {
      turns: snapshot.usage.turns + 1,
      input: snapshot.usage.input + (usage?.input ?? 0),
      output: snapshot.usage.output + (usage?.output ?? 0),
      cacheRead: snapshot.usage.cacheRead + (usage?.cacheRead ?? 0),
      cacheWrite: snapshot.usage.cacheWrite + (usage?.cacheWrite ?? 0),
      cost: snapshot.usage.cost + (usage?.cost?.total ?? 0),
      contextTokens: usage?.totalTokens ?? snapshot.usage.contextTokens,
    },
    model: message.model ?? snapshot.model,
    stopReason: message.stopReason ?? snapshot.stopReason,
    errorMessage: message.errorMessage ?? snapshot.errorMessage,
  }
}

/**
 * Resolves how to re-invoke the running pi harness: the current entry script
 * via the current runtime, the executable itself (compiled binaries), or
 * `pi` on PATH.
 */
function resolvePiInvocation(args: ReadonlyArray<string>): {
  command: string
  args: ReadonlyArray<string>
} {
  const currentScript = process.argv[1]
  const isBunVirtualScript = currentScript?.startsWith('/$bunfs/root/')
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] }
  }

  const execName = path.basename(process.execPath).toLowerCase()
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName)
  if (!isGenericRuntime) {
    return { command: process.execPath, args }
  }

  return { command: 'pi', args }
}

/**
 * Runs one headless pi instance for the given prompt and folds its JSONL
 * event stream into a `SubagentResult`.
 *
 * The prompt is piped via stdin to avoid argv length limits. Interruption
 * kills the child via the enclosing scope, and spawn/stream failures are
 * folded into a failed result instead of an error channel.
 */
export function runSubagent(
  options: RunSubagentOptions,
): Effect.Effect<SubagentResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.scoped(
    Effect.gen(function* () {
      // `--exclude-tools subagent` prevents children from recursively
      // spawning their own subagents.
      const args = [
        '--mode',
        'json',
        '-p',
        '--no-session',
        '--exclude-tools',
        'subagent',
      ]
      // Inherit the parent's active tool set so a restricted parent
      // (e.g. `--tools read`) cannot be escaped through the child.
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
      const invocation = resolvePiInvocation(args)
      const handle = yield* ChildProcess.make(
        invocation.command,
        [...invocation.args],
        {
          cwd: options.cwd,
          stdin: Stream.make(new TextEncoder().encode(options.prompt)),
          forceKillAfter: FORCE_KILL_AFTER,
        },
      )

      options.onUpdate?.(initialSnapshot)

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

      const finalSnapshot = yield* handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filterMap(
          Filter.fromPredicateOption(
            Schema.decodeUnknownOption(AssistantMessageEnd),
          ),
        ),
        Stream.runFoldEffect(
          () => initialSnapshot,
          (snapshot, event) =>
            Effect.sync(() => {
              const next = foldMessage(snapshot, event.message)
              options.onUpdate?.(next)
              return next
            }),
        ),
      )

      const exitCode = yield* handle.exitCode
      const stderr = yield* Fiber.join(stderrFiber)

      // A clean exit without a single decoded assistant message means the
      // child produced no usable output (wrong invocation, polluted stdout,
      // JSON format drift, ...).
      if (Number(exitCode) === 0 && finalSnapshot.usage.turns === 0) {
        const detail = stderr.trim()
        return {
          ...finalSnapshot,
          stopReason: 'error',
          errorMessage:
            'Subagent produced no assistant messages (unexpected or empty JSON event stream)' +
            (detail.length > 0 ? `\nstderr: ${detail}` : ''),
          exitCode: Number(exitCode),
          stderr,
        }
      }

      return { ...finalSnapshot, exitCode: Number(exitCode), stderr }
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.succeed<SubagentResult>({
        ...initialSnapshot,
        stopReason: 'error',
        errorMessage: `Failed to run subagent: ${error.message}`,
        exitCode: 1,
        stderr: '',
      }),
    ),
  )
}

/** Whether a finished run should be reported to the model as a failure. */
export function isFailure(result: SubagentResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === 'error' ||
    result.stopReason === 'aborted'
  )
}
