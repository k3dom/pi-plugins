import { Data, Effect, Fiber, Stream } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/** A git invocation exited with a nonzero status. */
export class GitError extends Data.TaggedError('GitError')<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {
  override readonly message: string =
    `git ${this.args.join(' ')} exited with ${this.exitCode}` +
    (this.stderr.trim() ? `: ${this.stderr.trim()}` : '')
}

/**
 * Runs `git` with the given arguments and returns its stdout, failing with
 * `GitError` on a nonzero exit code.
 */
export function runGit(
  args: ReadonlyArray<string>,
  options: { readonly cwd: string },
): Effect.Effect<
  string,
  GitError | PlatformError,
  ChildProcessSpawner.ChildProcessSpawner
> {
  return Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make('git', [...args], {
        cwd: options.cwd,
      })

      const stderrFiber = yield* Effect.forkScoped(
        Stream.mkString(Stream.decodeText(handle.stderr)),
      )
      const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
      const exitCode = Number(yield* handle.exitCode)
      const stderr = yield* Fiber.join(stderrFiber)

      if (exitCode !== 0) {
        return yield* new GitError({ args, exitCode, stderr })
      }
      return stdout
    }),
  )
}
