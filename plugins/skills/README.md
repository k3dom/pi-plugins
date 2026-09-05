# `@pi-plugins/skills`

Review code for bugs and opportunities to simplify with on-demand skills for
[pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@pi-plugins/skills
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/skills
```

## Usage

Run a skill with an optional PR number, branch name, or file path:

```text
/skill:code-review 1234
/skill:simplify src/api
```

Without an argument, both review the current diff against upstream, including
uncommitted changes. Both report findings without editing files.

## Available skills

| Skill                                        | What it does                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------------------- |
| [`code-review`](skills/code-review/SKILL.md) | Find correctness bugs in a diff and rank findings by severity.               |
| [`simplify`](skills/simplify/SKILL.md)       | Suggest ways to simplify code, reuse existing logic, and improve efficiency. |

## Notes

Both skills require a `subagent` tool. Install [`subagent`](../subagent) if you do
not already have a compatible tool.
