import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import { Array, Effect, Option, pipe, Schema } from 'effect'
import { Snapshotter, SnapshotterError } from './snapshot'

/** `customType` of the hidden session entries that carry a snapshot tree hash. */
const CHECKPOINT_TYPE = 'file-checkpoint'

/** User-facing choices when navigating to a point with a different file state. */
const CHOICE_CONVERSATION = 'Conversation only (keep files as they are)'
const CHOICE_RESTORE = 'Conversation and files'
const CHOICE_CANCEL = 'Cancel navigation'

/** The tree hash stored on `entry`, if it is one of our checkpoint entries. */
function checkpointOf(entry: SessionEntry | undefined): string | undefined {
  if (entry?.type !== 'custom' || entry.customType !== CHECKPOINT_TYPE) {
    return undefined
  }

  return pipe(
    Schema.decodeUnknownOption(Schema.Struct({ tree: Schema.String }))(entry.data),
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
    if (!entry) {
      return undefined
    }

    const tree = checkpointOf(entry)
    if (tree) {
      return tree
    }

    id = entry.parentId
  }

  return undefined
}

/**
 * The file state associated with navigating to `targetId`: a checkpoint
 * directly below the target, or the nearest ancestor checkpoint.
 */
function restoreTree(
  session: ExtensionContext['sessionManager'],
  targetId: string,
): string | undefined {
  return pipe(
    session.getEntries(),
    Array.findFirst((entry) =>
      entry.parentId === targetId
        ? Option.fromUndefinedOr(checkpointOf(entry))
        : Option.none(),
    ),
    Option.getOrElse(() => nearestCheckpoint(session, targetId)),
  )
}

export default function checkpoint(pi: ExtensionAPI) {
  let snapshotter: Snapshotter['Service'] | undefined

  pi.on('session_start', async (_event, ctx) => {
    // Only active inside git worktrees.
    snapshotter = await Effect.runPromise(
      Snapshotter.make(ctx.cwd).pipe(
        Effect.provide(NodeServices.layer),
        Effect.catch((error) =>
          Effect.sync(() => {
            const expected =
              error instanceof SnapshotterError && error.kind === 'NotAWorktree'
            if (ctx.hasUI && !expected) {
              ctx.ui.notify(`Checkpoints disabled: ${error.message}`, 'warning')
            }
            return undefined
          }),
        ),
      ),
    )
  })

  /**
   * Records the current file state as a checkpoint at the current leaf,
   * skipping entries when the branch already ends in an identical state.
   * Running on both `turn_start` and `turn_end` brackets every turn with a
   * before/after snapshot pair.
   */
  const recordCheckpoint = async (ctx: ExtensionContext) => {
    if (!snapshotter) {
      return
    }
    // Current worktree state as a tree hash, or undefined when tracking fails.
    const tree = await Effect.runPromise(
      snapshotter.track().pipe(Effect.orElseSucceed(() => undefined)),
    )
    if (!tree) {
      return
    }
    const session = ctx.sessionManager
    if (nearestCheckpoint(session, session.getLeafId()) !== tree) {
      pi.appendEntry(CHECKPOINT_TYPE, { tree })
    }
  }

  pi.on('turn_start', async (_event, ctx) => recordCheckpoint(ctx))
  pi.on('turn_end', async (_event, ctx) => recordCheckpoint(ctx))

  pi.registerCommand('checkpoint-cleanup', {
    description: 'Delete stored file checkpoint history for this worktree',
    handler: async (_args, ctx) => {
      await ctx.waitForIdle()
      if (!snapshotter || !ctx.hasUI) {
        return undefined
      }

      if (
        !(await ctx.ui.confirm(
          'Delete file checkpoints?',
          'This removes the stored file history for every session in this worktree. Conversation history is not affected.',
        ))
      ) {
        return undefined
      }

      await Effect.runPromise(
        snapshotter.cleanup().pipe(
          Effect.match({
            onSuccess: (tree) => {
              const session = ctx.sessionManager
              if (nearestCheckpoint(session, session.getLeafId()) !== tree) {
                pi.appendEntry(CHECKPOINT_TYPE, { tree })
              }
              ctx.ui.notify('File checkpoint history cleaned up', 'info')
            },
            onFailure: (error) => {
              ctx.ui.notify(`Checkpoint cleanup failed: ${error.message}`, 'error')
            },
          }),
        ),
      )
    },
  })

  pi.on('session_before_tree', async (event, ctx) => {
    if (!snapshotter || !ctx.hasUI) {
      return undefined
    }
    const session = ctx.sessionManager
    const target = restoreTree(session, event.preparation.targetId)
    if (!target) {
      return undefined
    }

    const current = await Effect.runPromise(
      snapshotter.track().pipe(Effect.orElseSucceed(() => undefined)),
    )
    if (!current || current === target) {
      return undefined
    }

    const choice = await ctx.ui.select(
      'Files changed since that point in the conversation. What should be restored?',
      [CHOICE_CONVERSATION, CHOICE_RESTORE, CHOICE_CANCEL],
    )
    if (choice !== CHOICE_RESTORE) {
      return choice === CHOICE_CANCEL ? { cancel: true } : undefined
    }

    // Preserve the abandoned state on the old branch so that navigating back
    // to it can restore the files again (redo).
    if (nearestCheckpoint(session, session.getLeafId()) !== current) {
      pi.appendEntry(CHECKPOINT_TYPE, { tree: current })
    }

    return Effect.runPromise(
      snapshotter.restore(target).pipe(
        Effect.match({
          onSuccess: () => {
            ctx.ui.notify('Files restored to the selected point', 'info')
            return undefined
          },
          onFailure: (error) => {
            ctx.ui.notify(`File restore failed: ${error.message}`, 'error')
            return { cancel: true }
          },
        }),
      ),
    )
  })
}
