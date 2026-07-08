# `@pi-plugins/prompts`

Read-only diff-review prompt templates for
[pi-agent](https://github.com/earendil-works/pi), invoked as `/<name>` slash
commands.

| Prompt                                  | Command        | What it does                                                                                                    |
| --------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------- |
| [`simplify`](prompts/simplify.md)       | `/simplify`    | Reviews the changed code — reuse, simplification, efficiency, altitude — and reports improvement opportunities. |
| [`code-review`](prompts/code-review.md) | `/code-review` | High-recall correctness review of a diff, ranked by severity. Catches bugs, not just style.                     |

## Install

```bash
pi install npm:@pi-plugins/prompts
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/prompts
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/prompts
```
