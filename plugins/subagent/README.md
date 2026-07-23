# `@pi-plugins/subagent`

A minimal subagent tool for [pi-agent](https://github.com/earendil-works/pi):
delegate a task to a fresh, headless pi instance with an isolated context window.

No agent presets, no orchestration modes — just a `subagent` tool that spawns another
instance of the running pi harness (`pi --mode json -p --no-session`) and returns its
final response. Child processes inherit the parent environment with
`PI_CACHE_RETENTION=short`, so they keep pi's standard provider cache retention
instead of inheriting a process-wide or OAuth-plugin extended setting.

## Install

```bash
pi install npm:@pi-plugins/subagent
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/subagent
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/subagent
```

## Tool parameters

| Parameter     | Required | Description                                                            |
| ------------- | -------- | ---------------------------------------------------------------------- |
| `description` | yes      | A short (3-5 word) description of the task                             |
| `prompt`      | yes      | The task for the agent to perform                                      |
| `model`       | no       | Model override for this agent (passed to `pi --model`)                 |
| `cwd`         | no       | Working directory for the agent process (defaults to the parent's cwd) |
