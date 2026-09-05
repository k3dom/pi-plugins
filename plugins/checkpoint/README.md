# `@pi-plugins/checkpoint`

Restore files alongside session history in [pi](https://github.com/earendil-works/pi)
using lightweight checkpoints.

## Install

```bash
pi install npm:@pi-plugins/checkpoint
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/checkpoint
```

## Usage

Requires Git and a Git repository. Checkpoints are created automatically, with no
configuration.

Use `/tree` to navigate session history. When the destination's files differ from
those on disk, choose whether to navigate with or without restoring files, or cancel.
Restoring files replaces the current worktree contents with the selected checkpoint.

- Navigating to a user message restores the files that prompt originally ran against,
  including manual edits made between turns.
- Navigating to the end of a turn restores the files as that turn left them.
- Checkpoints remain available after resuming a session with `pi --resume`.

### Cleanup

```text
/checkpoint-cleanup
```

After confirmation, this deletes checkpoint history for all sessions in the current
worktree and records the current files as a fresh baseline. Conversation history is
not deleted, but older conversation points can no longer restore their files.

## Notes

- Checkpoints do not change your Git history or staging area.
- New, untracked files are included unless ignored. Files excluded by `.gitignore`
  are not checkpointed or restored.
