import { getAgentDir } from '@earendil-works/pi-coding-agent'
import {
  Array,
  Context,
  Crypto,
  Effect,
  Encoding,
  Fiber,
  FileSystem,
  Path,
  pipe,
  Schema,
  Stream,
  String,
} from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import * as FileLock from './file-lock'

export class GitError extends Schema.TaggedError<GitError>()('GitError', {
  args: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stderr: Schema.String,
}) {
  override get message(): string {
    const failure = `git ${Array.join(this.args, ' ')} exited with ${this.exitCode}`
    const stderr = String.trim(this.stderr)
    return String.isEmpty(stderr) ? failure : `${failure}: ${stderr}`
  }
}

export class GitTimeout extends Schema.TaggedError<GitTimeout>()('GitTimeout', {
  args: Schema.Array(Schema.String),
}) {
  override get message(): string {
    return `git ${Array.join(this.args, ' ')} timed out after 1 minute`
  }
}

export class NotAWorktree extends Schema.TaggedError<NotAWorktree>()(
  'NotAWorktree',
  { cwd: Schema.String },
) {
  override get message(): string {
    return `Not a git worktree: ${this.cwd}`
  }
}

export class RollbackFailed extends Schema.TaggedError<RollbackFailed>()(
  'RollbackFailed',
  { cause: Schema.ErrorInstance(), rollbackCause: Schema.ErrorInstance() },
) {
  override get message(): string {
    return `${this.cause.message} (rollback also failed: ${this.rollbackCause.message})`
  }
}

export class SnapshotterError extends Schema.TaggedError<SnapshotterError>()(
  'SnapshotterError',
  {
    reason: Schema.Union([GitError, GitTimeout, NotAWorktree, RollbackFailed]),
  },
) {
  override get message(): string {
    return this.reason.message
  }
}

export class Snapshotter extends Context.Service<Snapshotter>()(
  '@pi-plugins/checkpoint/Snapshotter',
  {
    make: Effect.fnUntraced(function* (cwd: string) {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const crypto = yield* Crypto.Crypto
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const git = Effect.fnUntraced(
        function* (args: ReadonlyArray<string>, dir: string) {
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
          const exitCode = yield* handle.exitCode
          const stderr = yield* Fiber.join(stderrFiber)

          if (exitCode !== 0) {
            return yield* new SnapshotterError({
              reason: new GitError({ args, exitCode, stderr }),
            })
          }

          return stdout
        },
        Effect.scoped,
        (effect, args) =>
          effect.pipe(
            Effect.timeoutOrElse({
              duration: '1 minute',
              orElse: () =>
                new SnapshotterError({ reason: new GitTimeout({ args }) }),
            }),
          ),
      )

      const worktree = yield* git(['rev-parse', '--show-toplevel'], cwd).pipe(
        Effect.map(String.trim),
        Effect.catchReason(
          'SnapshotterError',
          'GitError',
          () => new SnapshotterError({ reason: new NotAWorktree({ cwd }) }),
        ),
      )
      if (String.isEmpty(worktree)) {
        return yield* new SnapshotterError({ reason: new NotAWorktree({ cwd }) })
      }

      const digest = yield* crypto.digest(
        'SHA-256',
        new TextEncoder().encode(worktree),
      )
      const gitdir = path.join(
        getAgentDir(),
        'checkpoints',
        String.takeLeft(Encoding.encodeHex(digest), 16),
      )

      const shadowGit = (args: ReadonlyArray<string>) =>
        git(
          [
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
          worktree,
        )

      yield* fs.makeDirectory(gitdir, { recursive: true })
      const lock = yield* FileLock.make(path.join(gitdir, 'checkpoint.lock'))

      yield* Effect.gen(function* () {
        if (!(yield* fs.exists(path.join(gitdir, 'HEAD')))) {
          yield* shadowGit(['init', '--quiet'])
        }
      }).pipe(lock.withLock)

      const writeTree = Effect.gen(function* () {
        yield* shadowGit(['add', '--all'])
        return yield* shadowGit(['write-tree']).pipe(Effect.map(String.trim))
      })

      const listIndexFiles = shadowGit(['ls-files', '-z']).pipe(
        Effect.map((out) =>
          pipe(out, String.split('\0'), Array.filter(String.isNonEmpty)),
        ),
      )

      // Assumes the shadow index reflects the current worktree state.
      const applyTree = Effect.fnUntraced(function* (tree: string) {
        const before = yield* listIndexFiles
        yield* shadowGit(['read-tree', tree])
        yield* shadowGit(['checkout-index', '--all', '--force'])
        const after = yield* listIndexFiles

        yield* Effect.forEach(
          Array.difference(before, after),
          (file) => Effect.ignore(fs.remove(path.join(worktree, file))),
          { discard: true, concurrency: 'unbounded' },
        )
      })

      const track = Effect.fn('Snapshotter.track')(() => writeTree, lock.withLock)

      const restore = Effect.fn('Snapshotter.restore')(function* (tree: string) {
        const current = yield* writeTree
        yield* applyTree(tree).pipe(
          Effect.tapError((cause) =>
            applyTree(current).pipe(
              Effect.mapError(
                (rollbackCause) =>
                  new SnapshotterError({
                    reason: new RollbackFailed({ cause, rollbackCause }),
                  }),
              ),
            ),
          ),
        )
      }, lock.withLock)

      const cleanup = Effect.fn('Snapshotter.cleanup')(function* () {
        const index = path.join(gitdir, 'index')
        if (yield* fs.exists(index)) {
          yield* fs.remove(index)
        }
        yield* shadowGit(['reflog', 'expire', '--expire=now', '--all'])
        yield* shadowGit(['gc', '--prune=now', '--quiet'])
        return yield* writeTree
      }, lock.withLock)

      return { track, restore, cleanup }
    }),
  },
) {}
