# `@pi-plugins/subagent`

Delegate a self-contained task to a separate
[pi](https://github.com/earendil-works/pi) session with its own context window.

## Install

```bash
pi install npm:@pi-plugins/subagent
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/subagent
```

## Usage

Ask pi to delegate a clearly scoped task with a concrete result:

```text
Use a subagent to review src/auth for correctness issues. Do not edit files.
Return findings with file paths and line numbers.
```

Pi waits for the subagent to finish, then returns its final response. Each subagent
starts without your conversation history, so give it a specific task and the context
it needs.

### Parameters

| Parameter     | Type     | Required | Description                                                                                        |
| ------------- | -------- | -------- | -------------------------------------------------------------------------------------------------- |
| `description` | `string` | Yes      | A short task label of 3 to 5 words.                                                                |
| `prompt`      | `string` | Yes      | The task, relevant context, whether edits are allowed, and the expected result.                    |
| `model`       | `string` | No       | A model override. Defaults to the current model and thinking level.                                |
| `cwd`         | `string` | No       | Working directory. Defaults to the current session's directory; relative paths resolve from there. |

## Sessions

To inspect delegated work, open the session ID shown in the tool result:

```bash
pi --session <id>
```

Subagent sessions are separate from your main session list. Pi offers to fork the
selected session into your current directory when you open it.

## Notes

Subagents can edit the same files as your main session. Explicitly ask for a
read-only task when you do not want changes.
