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

/** Failed to acquire the lock in time, or the attempt itself errored. */
export class FileLockError extends Data.TaggedError('FileLockError')<{
  lockPath: string
  cause: unknown
}> {
  override get message(): string {
    return `Could not acquire file lock: ${this.lockPath}`
  }
}

/** An inter-process lock backed by a lock directory on disk. */
export interface FileLock {
  /** Runs `self` while holding the lock. */
  withLock<A, E, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | FileLockError, R>
}

/**
 * Creates an inter-process `FileLock` at `lockPath`.
 *
 * Waiters fail with a `FileLockError` after 10 seconds. Abandoned locks are
 * broken: holders refresh the lock's mtime every 10 seconds, and a lock not
 * refreshed for 30 seconds is considered dead.
 */
export const make = Effect.fnUntraced(function* (lockPath: string) {
  const fs = yield* FileSystem.FileSystem

  /** Removes the lock if its holder stopped heartbeating (e.g. was killed). */
  const breakIfStale = Effect.fnUntraced(function* () {
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
  }, Effect.ignore)

  // Uninterruptible `makeDirectory` acquire; the polling between attempts
  // stays interruptible.
  const acquire = Effect.acquireRelease(fs.makeDirectory(lockPath), () =>
    Effect.ignore(fs.remove(lockPath, { recursive: true })),
  ).pipe(
    Effect.tapError((error) =>
      error.reason._tag === 'AlreadyExists' ? breakIfStale() : Effect.void,
    ),
    Effect.retry({
      while: (error) => error.reason._tag === 'AlreadyExists',
      schedule: Schedule.spaced('100 millis').pipe(
        Schedule.upTo({ duration: '10 seconds' }),
      ),
    }),
    Effect.mapError((cause) => new FileLockError({ lockPath, cause })),
  )

  /** Marks the lock as live so waiters do not break it. */
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
