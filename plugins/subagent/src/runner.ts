import * as fs from 'node:fs'
import * as path from 'node:path'
import { Data, Effect, Fiber, Filter, Schema, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
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

/**
 * Progress of a subagent run, emitted after every completed message and
 * returned as the final value of a successful run.
 */
export interface SubagentSnapshot {
  output: string
  /**
   * Latest thinking/reasoning summary. Used as a live status fallback for
   * models that emit no interim text between tool calls (e.g. OpenAI/codex
   * models, which only produce a text block on their final message).
   */
  thinking: string
  toolCalls: number
  usage: SubagentUsage
  model?: string | undefined
}

export const emptySnapshot: SubagentSnapshot = {
  output: '',
  thinking: '',
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

/**
 * The subagent stopped without completing its task: the child reported an
 * `error` or `aborted` stop reason on its final assistant message.
 */
export class SubagentStopError extends Data.TaggedError('SubagentStopError')<{
  readonly reason: 'error' | 'aborted'
  /** Error detail reported by the child, if any. */
  readonly errorMessage?: string | undefined
  readonly stderr: string
  /** Progress made up to the failure. */
  readonly snapshot: SubagentSnapshot
}> {
  override readonly message: string =
    this.errorMessage ||
    this.stderr.trim() ||
    this.snapshot.output ||
    `run stopped (${this.reason})`
}

/** The pi child process exited with a nonzero exit code. */
export class SubagentExitError extends Data.TaggedError('SubagentExitError')<{
  readonly exitCode: number
  readonly stderr: string
  /** Progress made up to the failure. */
  readonly snapshot: SubagentSnapshot
}> {
  override readonly message: string =
    this.stderr.trim() ||
    this.snapshot.output ||
    `pi exited with code ${this.exitCode}`
}

/**
 * The child exited cleanly but emitted no assistant messages, meaning it
 * produced no usable output (wrong invocation, polluted stdout, JSON format
 * drift, ...).
 */
export class SubagentNoOutputError extends Data.TaggedError(
  'SubagentNoOutputError',
)<{
  readonly stderr: string
}> {
  override readonly message: string =
    'Subagent produced no assistant messages (unexpected or empty JSON event stream)' +
    (this.stderr.trim() ? `\nstderr: ${this.stderr.trim()}` : '')
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
          thinking: Schema.optional(Schema.String),
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

/** Fold state: the public snapshot plus the child's last reported stop info. */
interface RunState {
  snapshot: SubagentSnapshot
  stopReason?: string | undefined
  errorMessage?: string | undefined
}

const initialState: RunState = { snapshot: emptySnapshot }

/** Folds one completed assistant message into the run state. */
function foldMessage(state: RunState, message: AssistantMessage): RunState {
  const { snapshot } = state
  let toolCalls = snapshot.toolCalls
  const texts: string[] = []
  const thinkingTexts: string[] = []
  for (const part of message.content) {
    if (part.type === 'text' && part.text !== undefined) {
      texts.push(part.text)
    } else if (part.type === 'thinking' && part.thinking !== undefined) {
      thinkingTexts.push(part.thinking)
    } else if (part.type === 'toolCall') {
      toolCalls += 1
    }
  }
  const text = texts.join('\n\n').trim()
  const output = text.length > 0 ? text : snapshot.output
  // Strip empty HTML-comment separators that codex reasoning summaries embed.
  const thinkingText = thinkingTexts
    .join('\n\n')
    .replace(/<!--\s*-->/g, '')
    .trim()
  const thinking = thinkingText.length > 0 ? thinkingText : snapshot.thinking

  const usage = message.usage
  return {
    snapshot: {
      output,
      thinking,
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
    },
    stopReason: message.stopReason ?? state.stopReason,
    errorMessage: message.errorMessage ?? state.errorMessage,
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
 * event stream into a `SubagentSnapshot`.
 */
export function runSubagent(options: {
  prompt: string
  /** Optional model override, passed to `pi --model`. */
  model?: string | undefined
  /** Working directory for the spawned pi process. */
  cwd?: string | undefined
  /** Tool allowlist for the child. */
  tools?: ReadonlyArray<string> | undefined
  /** Called with a fresh snapshot whenever the subagent completes a message. */
  onUpdate?: ((snapshot: SubagentSnapshot) => void) | undefined
}): Effect.Effect<
  SubagentSnapshot,
  SubagentStopError | SubagentExitError | SubagentNoOutputError | PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
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

      options.onUpdate?.(emptySnapshot)

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
          Filter.fromPredicateOption(
            Schema.decodeUnknownOption(AssistantMessageEnd),
          ),
        ),
        Stream.runFoldEffect(
          () => initialState,
          (previous, event) =>
            Effect.sync(() => {
              const next = foldMessage(previous, event.message)
              options.onUpdate?.(next.snapshot)
              return next
            }),
        ),
      )

      const exitCode = Number(yield* handle.exitCode)
      const stderr = yield* Fiber.join(stderrFiber)
      const { snapshot } = state

      if (state.stopReason === 'error' || state.stopReason === 'aborted') {
        return yield* new SubagentStopError({
          reason: state.stopReason,
          errorMessage: state.errorMessage,
          stderr,
          snapshot,
        })
      }
      if (exitCode !== 0) {
        return yield* new SubagentExitError({ exitCode, stderr, snapshot })
      }
      if (snapshot.usage.turns === 0) {
        return yield* new SubagentNoOutputError({ stderr })
      }

      return snapshot
    }),
  )
}
