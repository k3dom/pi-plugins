# pi-plugins

High-quality, single-purpose plugins for the
[pi-agent](https://github.com/earendil-works/pi) harness, built on
[Effect-TS](https://effect.website) primitives.

Each plugin does one thing well: clear inputs, predictable outputs, and an
implementation that leans on Effect for typed errors, resource safety, and composable
concurrency.

## Packages

| Package                                | Description                                                                                              | Tools / commands            |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------- |
| [`webfetch`](plugins/webfetch)         | Fetches content over HTTP(S) and returns them as Markdown or raw HTML.                                   | `web_fetch`                 |
| [`subagent`](plugins/subagent)         | Delegates a task to a fresh, headless pi instance with an isolated context window.                       | `subagent`                  |
| [`checkpoint`](plugins/checkpoint)     | Keeps `/tree` conversation navigation and files on disk in sync with lightweight file checkpoints.       | `/checkpoint-cleanup`       |
| [`fast-mode`](plugins/fast-mode)       | Toggles fast, priority inference for configured models on supported providers.                           | `/fast`, `--fast`           |
| [`claude-oauth`](plugins/claude-oauth) | Makes pi's Anthropic OAuth requests match the current Claude Code client so OAuth login works correctly. | —                           |
| [`exit`](plugins/exit)                 | Exits pi when `exit` or `quit` is submitted as the whole prompt.                                         | —                           |
| [`prompts`](plugins/prompts)           | A collection of prompt templates, invoked as slash commands.                                             | `/simplify`, `/code-review` |
| [`usage`](plugins/usage)               | Shows subscription usage/rate limits for Claude and OpenAI Codex plans.                                  | `/usage`                    |
| [`speed`](plugins/speed)               | Measures provider inference speed, including tokens per second and time to first token.                  | `/speed`                    |

## Usage

Install a published plugin with pi-agent:

```bash
pi install npm:@pi-plugins/webfetch
```

Or try it for a single run without adding it to settings:

```bash
pi -e npm:@pi-plugins/webfetch
```

For local development, load a plugin directly from its package directory:

```bash
pi -e ./plugins/webfetch
```

Then ask pi to use the tool it registers — for example, to fetch a URL.

## Nix

This repo contains a Nix flake with a development shell for local checks.

```bash
nix develop
ci
```

## License

[MIT](LICENSE)
