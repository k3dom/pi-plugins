import {
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Option,
  Schedule,
  Scope,
} from 'effect'

export class FileLockError extends Data.TaggedError('FileLockError')<{
  lockPath: string
  cause: unknown
}> {
  override get message(): string {
    return `Could not acquire file lock: ${this.lockPath}`
  }
}

export interface FileLock {
  withLock<A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | FileLockError, R>
}

export const make = Effect.fnUntraced(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem

  const acquire = Effect.acquireRelease(fs.makeDirectory(lockPath), () =>
    Effect.ignore(fs.remove(lockPath, { recursive: true })),
  ).pipe(
    Effect.tapError((error) =>
      error.reason._tag !== 'AlreadyExists'
        ? Effect.void
        : Effect.gen(function* () {
            // A holder that stopped heartbeating (e.g. was killed) is broken.
            const { mtime } = yield* fs.stat(lockPath)
            const now = yield* DateTime.now
            const stale = Option.exists(mtime, (time) =>
              Duration.isGreaterThan(
                DateTime.distance(DateTime.fromDateUnsafe(time), now),
                Duration.seconds(30),
              ),
            )
            if (stale) {
              yield* fs.remove(lockPath, { recursive: true })
            }
          }).pipe(Effect.ignore),
    ),
    Effect.retry({
      while: (error) => error.reason._tag === 'AlreadyExists',
      schedule: Schedule.spaced('100 millis').pipe(
        Schedule.upTo({ duration: '10 seconds' }),
      ),
    }),
    Effect.mapError((cause) => new FileLockError({ lockPath, cause })),
  )

  const heartbeat = Effect.gen(function* () {
    const now = yield* DateTime.nowAsDate
    yield* fs.utimes(lockPath, now, now)
  }).pipe(Effect.ignore, Effect.repeat(Schedule.spaced('10 seconds')))

  const lock: FileLock = {
    withLock: (self) =>
      Effect.scopedWith((scope) =>
        Effect.gen(function* () {
          yield* Scope.provide(scope)(acquire)
          yield* Scope.provide(scope)(Effect.forkScoped(heartbeat))
          return yield* self
        }),
      ),
  }

  return lock
})
