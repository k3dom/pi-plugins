/**
 * Checkpoint extension: keeps `/tree` navigation and the files on disk in
 * sync.
 *
 * At the start of every agent turn the extension snapshots the worktree into
 * a shadow git repository and records the resulting tree hash as a hidden
 * custom entry in the session. When the user navigates the conversation tree,
 * it looks up the file state belonging to the target entry and — if the files
 * on disk have since diverged — asks whether to restore them as well.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Effect, Option, pipe, Schema } from 'effect'
import {
  makeSnapshotter,
  resolveWorktree,
  type SnapshotDeps,
  type Snapshotter,
} from './snapshot'

/** `customType` of the hidden session entries that carry a snapshot tree hash. */
const CHECKPOINT_TYPE = 'file-checkpoint'

const CHOICE_CONVERSATION = 'Conversation only (keep files as they are)'
const CHOICE_RESTORE = 'Conversation and files'
const CHOICE_CANCEL = 'Cancel navigation'

const CheckpointData = Schema.Struct({ tree: Schema.String })

/** The tree hash stored on `entry`, if it is one of our checkpoint entries. */
function checkpointOf(entry: SessionEntry | undefined): string | undefined {
  if (
    entry === undefined ||
    entry.type !== 'custom' ||
    entry.customType !== CHECKPOINT_TYPE
  ) {
    return undefined
  }

  return pipe(
    Schema.decodeUnknownOption(CheckpointData)(entry.data),
    Option.map((data) => data.tree),
    Option.getOrUndefined,
  )
}

/** Nearest checkpoint at or above `fromId` in the session tree. */
function nearestCheckpoint(
  session: ExtensionContext['sessionManager'],
  fromId: string | null,
): string | undefined {
  for (let id = fromId; id !== null; ) {
    const entry = session.getEntry(id)
    if (entry === undefined) {
      return undefined
    }

    const tree = checkpointOf(entry)
    if (tree !== undefined) {
      return tree
    }

    id = entry.parentId
  }

  return undefined
}

/**
 * The file state associated with navigating to `targetId`.
 *
 * Checkpoints are appended right after the entry that started a turn, so a
 * direct child checkpoint captures the state exactly as of `targetId`.
 * Otherwise the nearest ancestor checkpoint is the best (turn-granular)
 * approximation: at most one turn's tool changes lie between the two.
 */
function restoreTree(
  session: ExtensionContext['sessionManager'],
  targetId: string,
): string | undefined {
  for (const entry of session.getEntries()) {
    if (entry.parentId === targetId) {
      const tree = checkpointOf(entry)
      if (tree !== undefined) {
        return tree
      }
    }
  }

  return nearestCheckpoint(session, targetId)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const run = <A, E>(effect: Effect.Effect<A, E, SnapshotDeps>): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

export default function checkpoint(pi: ExtensionAPI) {
  let snapshotter: Snapshotter | undefined

  /** Current worktree state as a tree hash, or undefined when tracking fails. */
  const currentTree = async (): Promise<string | undefined> => {
    if (snapshotter === undefined) {
      return undefined
    }
    return run(snapshotter.track.pipe(Effect.orElseSucceed(() => undefined)))
  }

  pi.on('session_start', async (_event, ctx) => {
    // Only active inside git worktrees; snapshotting relies on .gitignore to
    // keep dependency/build trees out of the shadow repository.
    snapshotter = await run(
      resolveWorktree(ctx.cwd).pipe(
        Effect.map(makeSnapshotter),
        Effect.orElseSucceed(() => undefined),
      ),
    )
  })

  pi.on('turn_start', async (_event, ctx) => {
    const tree = await currentTree()
    if (tree === undefined) {
      return
    }
    const session = ctx.sessionManager
    // Only record state changes: skip when the branch already ends in an
    // identical checkpoint (e.g. turns that did not touch any files).
    if (nearestCheckpoint(session, session.getLeafId()) !== tree) {
      pi.appendEntry(CHECKPOINT_TYPE, { tree })
    }
  })

  pi.on('session_before_tree', async (event, ctx) => {
    if (snapshotter === undefined) {
      return undefined
    }
    const session = ctx.sessionManager
    const target = restoreTree(session, event.preparation.targetId)
    if (target === undefined) {
      return undefined
    }

    const current = await currentTree()
    if (current === undefined || current === target || !ctx.hasUI) {
      return undefined
    }

    const choice = await ctx.ui.select(
      'Files changed since that point in the conversation. What should be restored?',
      [CHOICE_CONVERSATION, CHOICE_RESTORE, CHOICE_CANCEL],
    )
    if (choice === CHOICE_CANCEL) {
      return { cancel: true }
    }
    if (choice !== CHOICE_RESTORE) {
      return undefined
    }

    // Preserve the abandoned state on the old branch so that navigating back
    // to it can restore the files again (redo).
    if (nearestCheckpoint(session, session.getLeafId()) !== current) {
      pi.appendEntry(CHECKPOINT_TYPE, { tree: current })
    }

    try {
      await run(snapshotter.restore(target))
      ctx.ui.notify('Files restored to the selected point', 'info')
      return undefined
    } catch (error) {
      ctx.ui.notify(`File restore failed: ${errorMessage(error)}`, 'error')
      return { cancel: true }
    }
  })
}
