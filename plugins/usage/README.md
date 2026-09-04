# `@pi-plugins/usage`

A [pi-agent](https://github.com/earendil-works/pi) extension that surfaces
subscription plan usage / rate limits via a `/usage` command and a compact
status-line widget.

Credentials are read from pi's auth store, so anything you have logged into with
`/login` works out of the box — no extra configuration required:

| Provider           | Endpoint                                                     | Credential                                      |
| ------------------ | ------------------------------------------------------------ | ----------------------------------------------- |
| Claude             | `GET https://api.anthropic.com/api/oauth/usage`              | `anthropic` OAuth token                         |
| OpenAI Codex       | `GET https://chatgpt.com/backend-api/wham/usage`             | `openai-codex` OAuth token + ChatGPT account id |
| GLM Coding         | `GET https://api.z.ai/api/monitor/usage/quota/limit`         | `zai` API key                                   |
| GLM Coding (China) | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `zai-coding-cn` API key                         |

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

Prints one section per provider with a progress bar, percentage and reset countdown
for each rate-limit window.

## Widget

While the active model belongs to one of the providers above, the session and weekly
rate limits are shown as small progress bars, each with the time left until it
resets, on the shared status line above the editor.

## Configuration

Optional config file at `<agent-dir>/extensions/usage.json` (typically
`~/.pi/agent/extensions/usage.json`):

```json
{
  "showWidget": true
}
```

- `showWidget`: show the rate-limit bars above the editor (default `true`).
