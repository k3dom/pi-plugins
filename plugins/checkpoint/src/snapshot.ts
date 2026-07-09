import { createHash } from 'node:crypto'
import * as nodePath from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  Context,
  Data,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Semaphore,
  Stream,
} from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

export type SnapshotDeps =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem

export type SnapshotError = GitError | PlatformError

/** A shadow-repo git invocation exited with a nonzero status. */
export class GitError extends Data.TaggedError('GitError')<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number
  readonly stderr: string
}> {
  override readonly message: string =
    `git ${this.args.join(' ')} exited with ${this.exitCode}` +
    (this.stderr.trim() ? `: ${this.stderr.trim()}` : '')
}

/** `cwd` is not inside a git worktree. */
export class NotAGitWorktreeError extends Data.TaggedError('NotAGitWorktreeError')<{
  readonly cwd: string
}> {}

export interface SnapshotterService {
  readonly worktree: string
  /** Stages the worktree and returns the tree hash of the current file state. */
  readonly track: () => Effect.Effect<string, SnapshotError>
  /**
   * Restores the worktree to a previously tracked tree: checks out every file
   * in the tree and deletes files that exist now but not in the tree.
   */
  readonly restore: (tree: string) => Effect.Effect<void, SnapshotError>
}

/** Resolves the repository root of `cwd`, failing if it is not inside a git worktree. */
export const resolveWorktree = Effect.fnUntraced(function* (cwd: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const out = yield* spawner.string(
    ChildProcess.make('git', ['rev-parse', '--show-toplevel'], { cwd }),
  )
  // `rev-parse --show-toplevel` prints nothing to stdout outside a worktree.
  const worktree = out.trim()
  if (worktree === '') {
    return yield* new NotAGitWorktreeError({ cwd })
  }
  return worktree
})

/**
 * Snapshots a git worktree into a shadow repository (a separate `GIT_DIR`
 * outside the project, opencode-style). A snapshot is just a `git write-tree`
 * of the shadow index — no commits, no refs, and the user's real `.git` is
 * never touched. The worktree's `.gitignore` files are respected.
 *
 * Constructed per worktree via {@link Snapshotter.make} (or
 * {@link Snapshotter.layer}); dependencies are resolved at construction time,
 * so the exposed methods are self-contained.
 */
export class Snapshotter extends Context.Service<Snapshotter, SnapshotterService>()(
  '@pi-plugins/checkpoint/Snapshotter',
  {
    make: Effect.fnUntraced(function* (worktree: string) {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      // Serializes shadow-index operations; concurrent `git add` would corrupt it.
      const semaphore = yield* Semaphore.make(1)
      const gitdir = nodePath.join(
        getAgentDir(),
        'checkpoints',
        createHash('sha256').update(worktree).digest('hex').slice(0, 16),
      )

      /**
       * Runs git against the shadow repository and returns its stdout,
       * failing with `GitError` on a nonzero exit code.
       */
      const git = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
        const handle = yield* spawner.spawn(
          ChildProcess.make(
            'git',
            [
              // Safety config so snapshots are byte-exact and independent of
              // user/system git configuration.
              '-c',
              'core.autocrlf=false',
              '-c',
              'core.quotepath=false',
              '-c',
              'core.fsmonitor=false',
              '--git-dir',
              gitdir,
              '--work-tree',
              worktree,
              ...args,
            ],
            { cwd: worktree },
          ),
        )
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
      }, Effect.scoped)

      /**
       * Syncs the shadow index with the current worktree state, initializing
       * the shadow repository on first use.
       */
      const stage = Effect.gen(function* () {
        if (!(yield* fs.exists(nodePath.join(gitdir, 'HEAD')))) {
          yield* fs.makeDirectory(gitdir, { recursive: true })
          yield* git(['init', '--quiet'])
        }
        yield* git(['add', '--all'])
      })

      const listIndexFiles = Effect.map(git(['ls-files', '-z']), (out) =>
        out.split('\0').filter((file) => file.length > 0),
      )

      const track = Effect.fn('Snapshotter.track')(function* () {
        yield* stage
        return (yield* git(['write-tree'])).trim()
      }, semaphore.withPermits(1))

      const restore = Effect.fn('Snapshotter.restore')(function* (tree: string) {
        yield* stage
        const before = yield* listIndexFiles
        yield* git(['read-tree', tree])
        yield* git(['checkout-index', '--all', '--force'])
        // Delete files that exist now but were absent at the snapshot.
        const after = new Set(yield* listIndexFiles)
        yield* Effect.forEach(
          before.filter((file) => !after.has(file)),
          (file) => Effect.ignore(fs.remove(nodePath.join(worktree, file))),
          { discard: true },
        )
      }, semaphore.withPermits(1))

      return { worktree, track, restore } as const
    }),
  },
) {
  static readonly layer = (worktree: string) =>
    Layer.effect(this, this.make(worktree))
}
