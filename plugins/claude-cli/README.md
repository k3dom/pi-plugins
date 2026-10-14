# `@pi-plugins/claude-cli`

Use a Claude subscription in [pi](https://github.com/earendil-works/pi) through the
official Claude Code CLI. Each model request runs as one `claude --print` process, so
sign-in, request format and billing are Claude Code's own. Pi keeps the conversation
and runs the tools.

## Requirements

The `claude` CLI must be on your `PATH` and signed in to a Pro or Max plan:

```bash
claude auth login
```

Requests are billed to the account `claude` is signed in to, not to pi's `/login`.

Tested with pi 1.2.0 and Claude Code 2.1.299.

## Install

```bash
pi install npm:@pi-plugins/claude-cli
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/claude-cli
```

## Usage

Pick a model from the `claude-cli` provider with `/model`, or start pi with one:

```bash
pi --model claude-cli/claude-sonnet-5-5
```

The provider offers the same Claude models as pi's built-in `anthropic` provider.

## How it works

Every request starts a fresh `claude` process, which signs the request and sends it
with your subscription. pi supplies the conversation, system prompt, tools and
thinking settings in place of Claude Code's own. Claude Code's tools, settings, MCP
servers, skills and project instructions stay off. The process is stopped as soon as
the model's response is complete, so Claude Code does not run tools or send follow-up
requests of its own.

API keys in the environment, such as `ANTHROPIC_API_KEY`, are not passed on, so
requests always use the subscription.

Cache retention follows pi's `PI_CACHE_RETENTION` setting. It is five minutes by
default and one hour with `long`.

When another Claude Code process is refreshing the login, the request waits and tries
again for up to a minute.

The [`usage`](../usage) plugin reads Claude limits through pi's own Anthropic login.
To see them for this provider, sign in to the same account with `/login`.
