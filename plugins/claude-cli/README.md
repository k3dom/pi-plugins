# `@pi-plugins/claude-cli`

Use a Claude subscription in [pi](https://github.com/earendil-works/pi) through the
official Claude Code CLI. Every request is made by Claude Code itself, so using your
subscription this way stays within Anthropic's
[terms of service](https://www.anthropic.com/legal/consumer-terms).

## How it works

Every model request starts a fresh `claude --print` process. pi hands it the
conversation, system prompt, tools and thinking settings. Claude Code signs the
request and sends it with your subscription, so it counts against your plan's limits
like Claude Code's own requests. The process is stopped as soon as the response is
complete, so Claude Code never runs a tool or sends a request of its own.

Claude Code only signs you in, signs the request and sends it. Everything else stays
with pi:

- **Minimal system prompt.** The model gets pi's system prompt unchanged, after only
  Claude Code's billing header and a one-line identity. Claude Code's own prompt,
  project instructions, skills and environment details are left out.
- **pi's tools.** The model sees pi's tools under their own names, and pi runs them.
  Claude Code's built-in tools and MCP servers stay off.
- **pi's session.** pi keeps the conversation, compaction, retries and thinking
  level. Claude Code keeps no session of its own.
- **pi's prompt caching.** The cache anchor sits on the newest message, as in pi's
  Anthropic provider, so each request reads the earlier conversation from cache.
- **No copied request details.** The plugin pins no headers, version numbers or
  signing values from Claude Code. Claude Code builds and signs every request itself.

## Requirements

The `claude` CLI must be on your `PATH` and signed in to a Pro or Max plan:

```bash
claude auth login
```

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

## Notes

- Requests are billed to the account `claude` is signed in to, not to pi's `/login`.
  The [`usage`](../usage) plugin reads Claude limits through pi's login, so sign both
  in to the same account to see the right limits.
- API keys in the environment, such as `ANTHROPIC_API_KEY`, are not passed on to
  Claude Code, so requests always use the subscription.
- Cache retention follows pi's `PI_CACHE_RETENTION` setting. It is five minutes by
  default and one hour with `long`.
- When another Claude Code process is refreshing the login, a request waits and tries
  again for up to a minute.
