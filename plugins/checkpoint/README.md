# @pi-plugins/checkpoint

File checkpoints for [pi-agent](https://github.com/badlogic/pi-mono): keeps `/tree`
conversation navigation and the files on disk in sync.

Pi's `/tree` time-travels the conversation, but not the file changes the agent made
along the way. This extension snapshots the worktree at the start of every agent
turn; when you navigate the conversation tree to a point whose file state differs
from what is on disk, it asks:

- **Conversation only** — pi's default behavior, files stay as they are
- **Conversation and files** — restores the worktree to that point
- **Cancel navigation** — abort

Because the state you navigate away from is checkpointed too, navigating back to a
later node offers to restore ("redo") those changes again.

## How it works

Snapshots use a shadow git repository (a separate `GIT_DIR` under
`<agent-dir>/checkpoints/`, pointed at your worktree) in the style of opencode's
snapshot system:

- A snapshot is just a `git write-tree` of the shadow index — no commits, no refs,
  and your real `.git` is never touched.
- Your `.gitignore` files are respected, so `node_modules` and build output never
  enter the shadow repository.
- Tree hashes are persisted as hidden custom entries in the pi session file, so
  restore works across `pi --resume`.
- Restore checks out all files from the snapshot tree and deletes files that were
  created after it.

## Install

```bash
pi install npm:@pi-plugins/checkpoint
```

## Limitations (MVP)

- Only active when the project is a git repository.
- Turn-level granularity: navigating to an entry in the middle of a turn restores the
  state at the start of that turn.
- Manual edits made between agent turns are only captured at the next turn start; the
  very latest manual edits can be lost when restoring (a safety checkpoint is taken
  right before any restore, so anything present at navigation time is recoverable).
- No snapshot garbage collection yet; prune with
  `git --git-dir <agent-dir>/checkpoints/<hash> gc --prune=now` if needed.
- `/fork` and headless (`-p`) modes never restore files.
