import * as fs from 'node:fs'
import * as path from 'node:path'
import { Effect, Fiber, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

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
  model?: string
  stopReason?: string
  errorMessage?: string
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
  /** Called with a fresh snapshot whenever the subagent completes a message. */
  onUpdate?: ((snapshot: SubagentSnapshot) => void) | undefined
}

/** Shape of the `--mode json` event lines we care about (see pi docs/json.md). */
interface PiJsonEvent {
  type?: string
  message?: {
    role?: string
    content?: Array<{ type?: string; text?: string }>
    usage?: {
      input?: number
      output?: number
      cacheRead?: number
      cacheWrite?: number
      totalTokens?: number
      cost?: { total?: number }
    }
    model?: string
    stopReason?: string
    errorMessage?: string
  }
}

/**
 * Resolves how to spawn another instance of the currently running pi harness.
 *
 * Prefers re-running the current entry script with the current runtime,
 * falling back to the executable itself (compiled binaries) or `pi` on PATH.
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

function emptySnapshot(): SubagentSnapshot {
  return {
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
}

/** Folds one JSONL event from the subagent's stdout into the snapshot. */
function processEventLine(line: string, snapshot: SubagentSnapshot): boolean {
  if (!line.trim()) {
    return false
  }

  let event: PiJsonEvent
  try {
    event = JSON.parse(line) as PiJsonEvent
  } catch {
    return false
  }

  if (event.type !== 'message_end' || event.message?.role !== 'assistant') {
    return false
  }

  const message = event.message
  snapshot.usage.turns += 1

  const usage = message.usage
  if (usage) {
    snapshot.usage.input += usage.input ?? 0
    snapshot.usage.output += usage.output ?? 0
    snapshot.usage.cacheRead += usage.cacheRead ?? 0
    snapshot.usage.cacheWrite += usage.cacheWrite ?? 0
    snapshot.usage.cost += usage.cost?.total ?? 0
    snapshot.usage.contextTokens = usage.totalTokens ?? snapshot.usage.contextTokens
  }

  if (message.model !== undefined) {
    snapshot.model = message.model
  }
  if (message.stopReason !== undefined) {
    snapshot.stopReason = message.stopReason
  }
  if (message.errorMessage !== undefined) {
    snapshot.errorMessage = message.errorMessage
  }

  for (const part of message.content ?? []) {
    if (part.type === 'text' && part.text !== undefined) {
      snapshot.output = part.text
    } else if (part.type === 'toolCall') {
      snapshot.toolCalls += 1
    }
  }

  return true
}

/**
 * Runs one headless pi instance (`pi --mode json -p --no-session`) for the
 * given prompt and folds its JSONL event stream into a `SubagentResult`.
 *
 * The spawned process lives in an Effect scope, so interruption (e.g. the
 * tool-call `AbortSignal`) terminates it automatically.
 */
export function runSubagent(
  options: RunSubagentOptions,
): Effect.Effect<
  SubagentResult,
  PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const args = ['--mode', 'json', '-p', '--no-session']
      if (options.model !== undefined) {
        args.push('--model', options.model)
      }
      args.push(options.prompt)

      const invocation = resolvePiInvocation(args)
      const handle = yield* ChildProcess.make(
        invocation.command,
        [...invocation.args],
        {
          cwd: options.cwd,
          stdin: 'ignore',
        },
      )

      const snapshot = emptySnapshot()
      options.onUpdate?.({ ...snapshot, usage: { ...snapshot.usage } })

      const stderrFiber = yield* Effect.forkScoped(
        Stream.mkString(Stream.decodeText(handle.stderr)),
      )

      yield* handle.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Effect.sync(() => {
            if (processEventLine(line, snapshot)) {
              options.onUpdate?.({ ...snapshot, usage: { ...snapshot.usage } })
            }
          }),
        ),
      )

      const exitCode = yield* handle.exitCode
      const stderr = yield* Fiber.join(stderrFiber)

      return { ...snapshot, exitCode: Number(exitCode), stderr }
    }),
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
