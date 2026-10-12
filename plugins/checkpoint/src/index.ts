import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@earendil-works/pi-coding-agent'
import * as NodeServices from '@effect/platform-node/NodeServices'
import * as Run from '@pi-plugins/shared/run'
import { Array, Effect, Option, pipe, Schema } from 'effect'
import * as Snapshotter from './snapshotter'

const CHECKPOINT_TYPE = 'file-checkpoint'

const Checkpoint = Schema.Struct({ tree: Schema.String })

function checkpointOf(entry: SessionEntry): Option.Option<string> {
  if (entry.type !== 'custom' || entry.customType !== CHECKPOINT_TYPE) {
    return Option.none()
  }

  return pipe(
    Schema.decodeUnknownOption(Checkpoint)(entry.data),
    Option.map((data) => data.tree),
  )
}

export default function checkpoint(pi: ExtensionAPI) {
  let snapshotter: Snapshotter.Snapshotter['Service'] | undefined

  pi.on('session_start', async (_event, ctx) => {
    snapshotter = await Run.handler(
      Snapshotter.Snapshotter.make(ctx.cwd).pipe(
        Effect.provide(NodeServices.layer),
        Effect.catchReason(
          'SnapshotterError',
          'NotAWorktree',
          () => Effect.undefined,
        ),
      ),
      {
        onError: (message) => {
          if (ctx.hasUI) {
            ctx.ui.notify(`Checkpoints disabled: ${message}`, 'warning')
          }
          return undefined
        },
      },
    )
  })

  const appendCheckpoint = (ctx: ExtensionContext, tree: string) => {
    const nearest = Array.findLast(ctx.sessionManager.getBranch(), checkpointOf)
    if (!Option.contains(nearest, tree)) {
      pi.appendEntry<typeof Checkpoint.Encoded>(CHECKPOINT_TYPE, { tree })
    }
  }

  const recordCheckpoint = async (ctx: ExtensionContext) => {
    if (!snapshotter) {
      return
    }
    const tree = await Run.handler(snapshotter.track())
    if (tree) {
      appendCheckpoint(ctx, tree)
    }
  }

  // Both hooks bracket every turn with a before/after snapshot pair.
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

      await Run.handler(
        snapshotter.cleanup().pipe(
          Effect.tap((tree) =>
            Effect.sync(() => {
              appendCheckpoint(ctx, tree)
              ctx.ui.notify('File checkpoint history cleaned up', 'info')
            }),
          ),
        ),
        {
          onError: (message) => {
            ctx.ui.notify(`Checkpoint cleanup failed: ${message}`, 'error')
          },
        },
      )
    },
  })

  pi.on('session_before_tree', async (event, ctx) => {
    if (!snapshotter || !ctx.hasUI) {
      return undefined
    }
    const session = ctx.sessionManager
    const targetId = event.preparation.targetId
    const target = pipe(
      session.getEntries(),
      Array.findFirst((entry) =>
        entry.parentId === targetId ? checkpointOf(entry) : Option.none(),
      ),
      Option.orElse(() => Array.findLast(session.getBranch(targetId), checkpointOf)),
    )
    if (Option.isNone(target)) {
      return undefined
    }

    const current = await Run.handler(snapshotter.track())
    if (!current || current === target.value) {
      return undefined
    }

    const conversationOnly = 'Conversation only (keep files as they are)'
    const restoreFiles = 'Conversation and files'
    const cancelNavigation = 'Cancel navigation'
    const choice = await ctx.ui.select(
      'Files changed since that point in the conversation. What should be restored?',
      [conversationOnly, restoreFiles, cancelNavigation],
    )
    if (choice !== restoreFiles) {
      return choice === cancelNavigation ? { cancel: true } : undefined
    }

    // Checkpoint the abandoned state on the old branch so navigating back can
    // restore it again (redo).
    appendCheckpoint(ctx, current)

    return Run.handler(
      snapshotter.restore(target.value).pipe(
        Effect.map(() => {
          ctx.ui.notify('Files restored to the selected point', 'info')
          return undefined
        }),
      ),
      {
        onError: (message) => {
          ctx.ui.notify(`File restore failed: ${message}`, 'error')
          return { cancel: true }
        },
      },
    )
  })
}
