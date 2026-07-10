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
  Semaphore,
  Stream,
  String,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

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
        Effect.catchTag('SnapshotterError', (error) =>
          error.kind === 'GitError'
            ? new SnapshotterError({
                kind: 'NotAWorktree',
                message: `Not a git worktree: ${cwd}`,
              })
            : Effect.fail(error),
        ),
      )
      if (pipe(worktree, String.trim, String.isEmpty)) {
        return yield* new SnapshotterError({
          kind: 'NotAWorktree',
          message: `Not a git worktree: ${cwd}`,
        })
      }

      // Serializes shadow-index operations; concurrent `git add` would corrupt it.
      const semaphore = yield* Semaphore.make(1)
      const digest = yield* crypto.digest(
        'SHA-256',
        new TextEncoder().encode(worktree),
      )
      const gitdir = path.join(
        getAgentDir(),
        'checkpoints',
        Encoding.encodeHex(digest).slice(0, 16),
      )

      if (!(yield* fs.exists(path.join(gitdir, 'HEAD')))) {
        yield* fs.makeDirectory(gitdir, { recursive: true })
        yield* git(shadowGit(['init', '--quiet']), worktree)
      }

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
      }, semaphore.withPermits(1))

      /**
       * Restores the worktree to the state of a snapshot, deleting files that
       * were present in the worktree but not in the snapshot.
       */
      const restore = Effect.fn('Snapshotter.restore')(function* (tree: string) {
        yield* git(shadowGit(['add', '--all']), worktree)
        const before = yield* listIndexFiles()
        yield* git(shadowGit(['read-tree', tree]), worktree)
        yield* git(shadowGit(['checkout-index', '--all', '--force']), worktree)
        const after = new Set(yield* listIndexFiles())

        yield* Effect.forEach(
          before.filter((file) => !after.has(file)),
          (file) => Effect.ignore(fs.remove(path.join(worktree, file))),
          { discard: true, concurrency: 'unbounded' },
        )
      }, semaphore.withPermits(1))

      return { track, restore } as const
    }),
  },
) {
  static readonly layer = (cwd: string) => Layer.effect(this, this.make(cwd))
}
