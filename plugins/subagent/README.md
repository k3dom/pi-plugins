# @pi-plugins/subagent

Minimal subagent tool for [pi-agent](https://github.com/earendil-works/pi): delegate
a task to a fresh, headless pi instance with an isolated context window.

No agent presets, no orchestration modes — just a `subagent` tool that spawns another
instance of the running pi harness (`pi --mode json -p --no-session`) and returns its
final response.

## Tool parameters

| Parameter     | Required | Description                                                            |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `description` | yes      | A short (3-5 word) description of the task                             |
| `prompt`      | yes      | The task for the agent to perform                                      |
| `model`       | no       | Model override for this agent (passed to `pi --model`)                 |
| `cwd`         | no       | Working directory for the agent process (defaults to the parent's cwd) |

## Behavior

- The subagent inherits nothing from the parent conversation; the prompt is its only
  input.
- The final assistant message is returned to the parent model, together with usage
  stats (turns, tokens, cost) in the TUI.
- Progress streams into the parent TUI while the subagent runs.
- Subagent token/cost usage is folded back into the parent session's cumulative stats
  (the footer totals), merged into the next finalized assistant message.
  Context-window usage is unaffected.
- Aborting the parent tool call (Ctrl+C) terminates the subagent process.
- Non-zero exit codes and `error`/`aborted` stop reasons are reported as tool errors.

## Install

```bash
pi install npm:@pi-plugins/subagent
```
