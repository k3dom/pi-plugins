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
    kind: Schema.Literals(['GitError', 'NotAWorktree']),
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

      // Resolve the canonical repository root by which the shadow `GIT_DIR` is keyed.
      const worktree = (yield* spawner.string(
        ChildProcess.make('git', ['rev-parse', '--show-toplevel'], { cwd }),
      )).trim()
      if (worktree === '') {
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

      /**
       * Runs git against the shadow repository and returns its stdout
       */
      const git = Effect.fnUntraced(function* (args: readonly string[]) {
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
          return yield* new SnapshotterError({
            kind: 'GitError',
            message:
              `git ${args.join(' ')} exited with ${exitCode}` +
              (stderr.trim() ? `: ${stderr.trim()}` : ''),
          })
        }

        return stdout
      }, Effect.scoped)

      if (!(yield* fs.exists(path.join(gitdir, 'HEAD')))) {
        yield* fs.makeDirectory(gitdir, { recursive: true })
        yield* git(['init', '--quiet'])
      }

      /**
       * Lists the paths currently tracked by the shadow index.
       */
      const listIndexFiles = Effect.fnUntraced(function* () {
        const out = yield* git(['ls-files', '-z'])
        return pipe(out, String.split('\0'), Array.filter(String.isNonEmpty))
      })

      /**
       * Creates a snapshot of the current worktree state.
       */
      const track = Effect.fn('Snapshotter.track')(function* () {
        yield* git(['add', '--all'])
        return yield* git(['write-tree']).pipe(Effect.map(String.trim))
      }, semaphore.withPermits(1))

      /**
       * Restores the worktree to the state of a snapshot, deleting files that
       * were present in the worktree but not in the snapshot.
       */
      const restore = Effect.fn('Snapshotter.restore')(function* (tree: string) {
        yield* git(['add', '--all'])
        const before = yield* listIndexFiles()
        yield* git(['read-tree', tree])
        yield* git(['checkout-index', '--all', '--force'])
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
