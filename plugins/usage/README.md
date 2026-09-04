# `@pi-plugins/usage`

A [pi-agent](https://github.com/earendil-works/pi) extension that surfaces the
subscription plan usage / rate limits for Anthropic Claude (Pro/Max), OpenAI Codex
(ChatGPT), and Z.ai/Zhipu GLM Coding plans via a `/usage` command and a compact
status-line widget.

Credentials are read from pi's auth store, so anything you have logged into with
`/login` works out of the box — no extra configuration required:

| Provider           | Endpoint                                                     | Credential                                      |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| Claude             | `GET https://api.anthropic.com/api/oauth/usage`              | `anthropic` OAuth token                         |
| OpenAI Codex       | `GET https://chatgpt.com/backend-api/wham/usage`             | `openai-codex` OAuth token + ChatGPT account id |
| GLM Coding         | `GET https://api.z.ai/api/monitor/usage/quota/limit`         | `zai` API key                                   |
| GLM Coding (China) | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `zai-coding-cn` API key                         |

Expired access tokens are refreshed transparently through pi's auth storage before
the usage request is made. The GLM coding plan uses whatever API key pi resolves for
the `zai` (or `zai-coding-cn`) provider, so `ZAI_API_KEY` / `ZAI_CODING_CN_API_KEY`
work as well as `/login`. `/usage` reports the platform you have a key for,
preferring the global one. The widget follows the active model's provider.

## Install

```bash
pi install npm:@pi-plugins/usage
```

For a one-off run without adding it to settings:

```bash
pi -e npm:@pi-plugins/usage
```

For local development, load it straight from this directory:

```bash
pi -e ./plugins/usage
```

## Usage

```text
/usage
```

Example output:

```text
Claude
  Session (5h)           [████░░░░░░]  42% · resets in 2h 13m
  Week (all models)      [██░░░░░░░░]  17% · resets in 4d 2h
  Week (Sonnet)          [█░░░░░░░░░]   8% · resets in 4d 2h
  Extra usage            [██░░░░░░░░]  23% €9.31 of €40.00

OpenAI Codex (pro)
  5h limit               [████░░░░░░]  42% · resets in 3h 25m
  Week limit             [████████░░]  84% · resets in 4d 2h

GLM Coding (max)
  Session (5h)           [█░░░░░░░░░]   7% · resets in 4h 17m · 2,096 of 28,000 credits
  Week                   [░░░░░░░░░░]   1% · resets in 5d 1h · 2,096 of 140,000 credits
```

## Widget

While the active model belongs to a subscription provider (`anthropic`,
`openai-codex`, `zai`, or `zai-coding-cn`), the session and weekly rate limits are
shown as small progress bars on the shared status line above the editor:

```text
5h ██░░░ 42% (2h) · wk █░░░░ 17% (4d)
```

The value in parentheses is the time left until that window resets.

The widget refreshes in the background (at most every 30 seconds) when a session
starts, a model is selected, or an agent turn settles, and reuses the data fetched by
`/usage`.

## Configuration

Optional config file at `<agent-dir>/extensions/usage.json` (typically
`~/.pi/agent/extensions/usage.json`):

```json
{
  "showWidget": true
}
```

- `showWidget`: show the rate-limit bars above the editor (default `true`).
