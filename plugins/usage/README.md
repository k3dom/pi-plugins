# `@pi-plugins/usage`

A [pi-agent](https://github.com/earendil-works/pi) extension that surfaces the
subscription plan usage / rate limits for Anthropic Claude (Pro/Max) and OpenAI Codex
(ChatGPT) plans via a `/usage` command and a compact status-line widget.

Credentials are read from pi's internal auth store, so anything you have logged into
with `/login` works out of the box — no extra configuration required:

| Provider     | Endpoint                                         | Credential (auth store)                         |
| ------------ | ------------------------------------------------ | ----------------------------------------------- |
| Claude       | `GET https://api.anthropic.com/api/oauth/usage`  | `anthropic` OAuth token                         |
| OpenAI Codex | `GET https://chatgpt.com/backend-api/wham/usage` | `openai-codex` OAuth token + ChatGPT account id |

Expired access tokens are refreshed transparently through pi's auth storage before
the usage request is made.

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
```

## Widget

While the active model belongs to a subscription provider (`anthropic` or
`openai-codex`), the session and weekly rate limits are shown as small progress bars
on the shared status line above the editor:

```text
5h ██░░░ 42% · wk █░░░░ 17%
```

The widget refreshes in the background (at most every 30 seconds) when a session
starts, a model is selected, or an agent loop finishes, and reuses the data fetched
by `/usage`. Fetch failures are silent on the status line — run `/usage` to see the
error.

## Configuration

Optional config file at `<agent-dir>/extensions/usage.json` (typically
`~/.pi/agent/extensions/usage.json`):

```json
{
  "showWidget": true
}
```

- `showWidget`: show the rate-limit bars above the editor (default `true`).
