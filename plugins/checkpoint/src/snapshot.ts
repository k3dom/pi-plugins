import { createHash } from 'node:crypto'
import * as nodePath from 'node:path'
import { getAgentDir } from '@earendil-works/pi-coding-agent'
import { Effect, FileSystem, Semaphore } from 'effect'
import type { PlatformError } from 'effect/PlatformError'
import type { ChildProcessSpawner } from 'effect/unstable/process'
import { GitError, runGit } from './git'

/**
 * Safety config applied to every shadow-repo command so snapshots are
 * byte-exact and independent of user/system git configuration.
 */
const SAFETY_CONFIG = [
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.quotepath=false',
  '-c',
  'core.fsmonitor=false',
] as const

export type SnapshotDeps =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem

export type SnapshotError = GitError | PlatformError

/**
 * Snapshots a git worktree into a shadow repository (a separate `GIT_DIR`
 * outside the project, opencode-style). A snapshot is just a `git write-tree`
 * of the shadow index — no commits, no refs, and the user's real `.git` is
 * never touched. The worktree's `.gitignore` files are respected.
 */
export interface Snapshotter {
  readonly worktree: string
  /** Stages the worktree and returns the tree hash of the current file state. */
  readonly track: Effect.Effect<string, SnapshotError, SnapshotDeps>
  /**
   * Restores the worktree to a previously tracked tree: checks out every file
   * in the tree and deletes files that exist now but not in the tree.
   */
  readonly restore: (
    tree: string,
  ) => Effect.Effect<void, SnapshotError, SnapshotDeps>
}

/** Resolves the repository root of `cwd`, failing if it is not inside a git worktree. */
export function resolveWorktree(
  cwd: string,
): Effect.Effect<string, SnapshotError, ChildProcessSpawner.ChildProcessSpawner> {
  return runGit(['rev-parse', '--show-toplevel'], { cwd }).pipe(
    Effect.map((out) => out.trim()),
  )
}

export function makeSnapshotter(worktree: string): Snapshotter {
  const gitdir = nodePath.join(
    getAgentDir(),
    'checkpoints',
    createHash('sha256').update(worktree).digest('hex').slice(0, 16),
  )
  // Serializes shadow-index operations; concurrent `git add` would corrupt it.
  const semaphore = Semaphore.makeUnsafe(1)

  const git = (args: ReadonlyArray<string>) =>
    runGit(
      [...SAFETY_CONFIG, '--git-dir', gitdir, '--work-tree', worktree, ...args],
      { cwd: worktree },
    )

  const ensureInit = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    if (yield* fs.exists(nodePath.join(gitdir, 'HEAD'))) {
      return
    }
    yield* fs.makeDirectory(gitdir, { recursive: true })
    yield* runGit(['--git-dir', gitdir, 'init', '--quiet'], { cwd: worktree })
  })

  /** Syncs the shadow index with the current worktree state. */
  const stage = Effect.gen(function* () {
    yield* ensureInit
    yield* git(['add', '--all'])
  })

  const listIndexFiles = Effect.map(git(['ls-files', '-z']), (out) =>
    out.split('\0').filter((file) => file.length > 0),
  )

  const track = semaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* stage
      return (yield* git(['write-tree'])).trim()
    }),
  )

  const restore = (tree: string) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        yield* stage
        const before = yield* listIndexFiles
        yield* git(['read-tree', tree])
        yield* git(['checkout-index', '--all', '--force'])
        // Delete files that exist now but were absent at the snapshot.
        const after = new Set(yield* listIndexFiles)
        const fs = yield* FileSystem.FileSystem
        yield* Effect.forEach(
          before.filter((file) => !after.has(file)),
          (file) => Effect.ignore(fs.remove(nodePath.join(worktree, file))),
          { discard: true },
        )
      }),
    )

  return { worktree, track, restore }
}
