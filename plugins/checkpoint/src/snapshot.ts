import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  Array,
  Context,
  Crypto,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  Layer,
  Path,
  pipe,
  Schema,
  Stream,
  String,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as FileLock from './file-lock'

export class SnapshotterError extends Schema.TaggedErrorClass<SnapshotterError>()(
  'SnapshotterError',
  {
    kind: Schema.Literals(['GitError', 'GitTimeout', 'NotAWorktree']),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Snapshots the git worktree containing `cwd` into a shadow repository (a
 * separate `GIT_DIR` outside the project).
 *
 * `make` fails with a `NotAWorktree` error outside git worktrees.
 */
export class Snapshotter extends Context.Service<Snapshotter>()(
  '@pi-plugins/checkpoint/Snapshotter',
  {
    make: Effect.fnUntraced(function* (cwd: string) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      /**
       * Runs `git args` in `dir` and returns its stdout, failing with a
       * `GitError` on non-zero exit. Invocations are killed after a timeout
       * so a hung git process cannot stall the agent's hooks indefinitely.
       */
      const git = Effect.fnUntraced(
        function* (args: readonly string[], dir: string) {
          const handle = yield* spawner.spawn(
            ChildProcess.make('git', args, {
              cwd: dir,
              forceKillAfter: '5 seconds',
            }),
          )
          const stderrFiber = yield* Effect.forkScoped(
            Stream.mkString(Stream.decodeText(handle.stderr)),
          )
          const stdout = yield* Stream.mkString(Stream.decodeText(handle.stdout))
          const exitCode = Number(yield* handle.exitCode)
          const stderr = yield* Fiber.join(stderrFiber)

          if (exitCode !== 0) {
            return yield* new SnapshotterError({
              kind: 'GitError',
              message:
                `git ${args.join(' ')} exited with ${exitCode}` +
                (stderr.trim() ? `: ${stderr.trim()}` : ''),
            })
          }

          return stdout
        },
        (effect, args) =>
          effect.pipe(
            Effect.scoped,
            Effect.timeoutOrElse({
              duration: '1 minute',
              orElse: () =>
                new SnapshotterError({
                  kind: 'GitTimeout',
                  message: `git ${args.join(' ')} timed out after 1 minute`,
                }),
            }),
          ),
      )

      /**
       * Wraps `args` with the arguments that point git at the shadow
       * repository and additional safety configuration.
       */
      const shadowGit = (args: readonly string[]): readonly string[] => [
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
      ]

      // Resolve the canonical repository root by which the shadow `GIT_DIR` is keyed.
      const worktree = yield* git(['rev-parse', '--show-toplevel'], cwd).pipe(
        Effect.map(String.trim),
        Effect.catchTag('SnapshotterError', (error) =>
          error.kind === 'GitError'
            ? new SnapshotterError({
                kind: 'NotAWorktree',
                message: `Not a git worktree: ${cwd}`,
              })
            : Effect.fail(error),
        ),
      )
      if (String.isEmpty(worktree)) {
        return yield* new SnapshotterError({
          kind: 'NotAWorktree',
          message: `Not a git worktree: ${cwd}`,
        })
      }

      const digest = yield* crypto.digest(
        'SHA-256',
        new TextEncoder().encode(worktree),
      )
      const gitdir = path.join(
        getAgentDir(),
        'checkpoints',
        Encoding.encodeHex(digest).slice(0, 16),
      )

      yield* fs.makeDirectory(gitdir, { recursive: true })
      const lock = yield* FileLock.make(path.join(gitdir, 'checkpoint.lock'))

      yield* lock.withLock(
        Effect.gen(function* () {
          if (!(yield* fs.exists(path.join(gitdir, 'HEAD')))) {
            yield* git(shadowGit(['init', '--quiet']), worktree)
          }
        }),
      )

      /**
       * Lists the paths currently tracked by the shadow index.
       */
      const listIndexFiles = Effect.fnUntraced(function* () {
        const out = yield* git(shadowGit(['ls-files', '-z']), worktree)
        return pipe(out, String.split('\0'), Array.filter(String.isNonEmpty))
      })

      /**
       * Creates a snapshot of the current worktree state.
       */
      const track = Effect.fn('Snapshotter.track')(function* () {
        yield* git(shadowGit(['add', '--all']), worktree)
        return yield* git(shadowGit(['write-tree']), worktree).pipe(
          Effect.map(String.trim),
        )
      }, lock.withLock)

      /**
       * Applies a snapshot to the worktree: checks out its files and deletes
       * files tracked in the shadow index but absent from the snapshot.
       * Assumes the shadow index reflects the current worktree state.
       */
      const applyTree = Effect.fnUntraced(function* (tree: string) {
        const before = yield* listIndexFiles()
        yield* git(shadowGit(['read-tree', tree]), worktree)
        yield* git(shadowGit(['checkout-index', '--all', '--force']), worktree)
        const after = new Set(yield* listIndexFiles())

        yield* Effect.forEach(
          before.filter((file) => !after.has(file)),
          (file) => Effect.ignore(fs.remove(path.join(worktree, file))),
          { discard: true, concurrency: 'unbounded' },
        )
      })

      /**
       * Restores the worktree to the state of a snapshot, deleting files that
       * were present in the worktree but not in the snapshot.
       *
       * A failed restore is rolled back to the pre-restore state so that a
       * partial checkout never leaves the worktree in a mixed state.
       */
      const restore = Effect.fn('Snapshotter.restore')(function* (tree: string) {
        // Snapshot the current state as the rollback point.
        yield* git(shadowGit(['add', '--all']), worktree)
        const current = yield* git(shadowGit(['write-tree']), worktree).pipe(
          Effect.map(String.trim),
        )

        yield* applyTree(tree).pipe(
          Effect.tapError((error) =>
            applyTree(current).pipe(
              Effect.mapError(
                (rollbackError) =>
                  new SnapshotterError({
                    kind: 'GitError',
                    message: `${error.message} (rollback also failed: ${rollbackError.message})`,
                    cause: error,
                  }),
              ),
            ),
          ),
        )
      }, lock.withLock)

      return { track, restore } as const
    }),
  },
) {
  static readonly layer = (cwd: string) => Layer.effect(this, this.make(cwd))
}
