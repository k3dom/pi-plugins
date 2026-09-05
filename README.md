# pi-plugins

Focused plugins for everyday work in [pi](https://github.com/earendil-works/pi).

Fetch web pages, delegate tasks, restore files as you navigate session history, and
keep an eye on speed and usage. Each package adds a specific capability. Install only
the pieces you need.

## Plugins

| Package                                | What it does                                                       | Entry point                             |
| -------------------------------------- | ------------------------------------------------------------------ | --------------------------------------- |
| [`checkpoint`](plugins/checkpoint)     | Restore files when navigating session history.                     | `/tree`, `/checkpoint-cleanup`          |
| [`claude-oauth`](plugins/claude-oauth) | Adapt Anthropic OAuth requests for use with a Claude subscription. | Automatic                               |
| [`elapsed`](plugins/elapsed)           | Show a live timer in the working indicator.                        | Automatic                               |
| [`exit`](plugins/exit)                 | Quit pi with a plain-text prompt.                                  | `exit`, `quit`                          |
| [`fast-mode`](plugins/fast-mode)       | Request priority inference for selected models.                    | `/fast`, `--fast`                       |
| [`skills`](plugins/skills)             | Review code for bugs and opportunities to simplify.                | `/skill:code-review`, `/skill:simplify` |
| [`speed`](plugins/speed)               | Show estimated generation speed and time to first token.           | Automatic                               |
| [`subagent`](plugins/subagent)         | Delegate a self-contained task to a separate pi session.           | `subagent`                              |
| [`usage`](plugins/usage)               | Check Claude, OpenAI Codex, and GLM Coding plan limits.            | `/usage`                                |
| [`webfetch`](plugins/webfetch)         | Fetch web pages as Markdown or raw HTML.                           | `web_fetch`                             |

## Requirements

Pi **0.80.10 or newer** is required. Check each plugin's README for any additional
requirements.

## Install

Install a package by name:

```bash
pi install npm:@pi-plugins/webfetch
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/webfetch
```

Replace `webfetch` with any package listed above.

## Usage

Some plugins add tools the agent can call, others add commands or update the
interface automatically. Each plugin's README explains how to use it.

For example, after installing `webfetch`, ask pi:

```text
Fetch https://example.com and summarize the page.
```

## Development

From the repository root, enter the Nix development shell and run the checks:

```bash
nix develop
ci
```

The `ci` command installs workspace dependencies, then runs formatting, lint, type
checks, builds, and tests.

After building, load a local package for one session:

```bash
pi -e ./plugins/webfetch
```

## License

[MIT](LICENSE)
