# @pi-plugins/checkpoint

File checkpoints for [pi-agent](https://github.com/badlogic/pi-mono): keeps `/tree`
conversation navigation and the files on disk in sync.

## How it works

Snapshots use a shadow git repository (a separate `GIT_DIR` under
`<agent-dir>/checkpoints/`, pointed at your worktree.

- A snapshot is just a `git write-tree` of the shadow index — no commits, no refs,
  and your real `.git` is never touched.
- Your `.gitignore` files are respected, so `node_modules` and build output never
  enter the shadow repository.
- Tree hashes are persisted as hidden custom entries in the pi session file, so
  restore works across `pi --resume`.

## Install

```bash
pi install npm:@pi-plugins/checkpoint
```

For one-off testing without adding it to settings:

```bash
pi -e npm:@pi-plugins/checkpoint
```
