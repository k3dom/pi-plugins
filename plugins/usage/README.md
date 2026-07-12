# `@pi-plugins/usage`

A [pi-agent](https://github.com/earendil-works/pi) extension that surfaces the
subscription plan usage / rate limits for Anthropic Claude (Pro/Max) and OpenAI Codex
(ChatGPT) plans via a `/usage` command.

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
