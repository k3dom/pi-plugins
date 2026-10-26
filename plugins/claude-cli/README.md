# `@pi-plugins/claude-cli`

Use a Claude subscription in [pi](https://github.com/earendil-works/pi) through the
official Claude Code CLI. Every request is made by Claude Code itself and draws from
your plan's usage limits, like Claude Code's own requests.

<!-- prettier-ignore -->
> [!NOTE]
> Anthropic decides how requests from `claude --print` are billed. In May 2026 it
> [announced](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
> that they and third-party apps would move to a separate credit, and in June it paused
> that change. They still draw from your plan's limits for now. If Anthropic changes
> this, the plugin may cost more or stop working, though it stops as soon as a request
> is charged to [usage credits](#usage-credits) unless you allow them.

## How it works

pi's built-in Anthropic provider builds each request and reads the response, just as
it does for the `anthropic` provider. Only sending the request is left to Claude
Code. Every request runs in its own `claude --print` process, which signs the request
and sends it with your subscription, so it counts against your plan's limits like
Claude Code's own requests. The process is stopped once the response is complete and
Claude Code has reported which limits paid for it, so Claude Code never runs a tool
or sends a request of its own.

Claude Code only signs you in, signs the request and sends it. Everything else stays
with pi:

- **Minimal system prompt.** The model gets pi's system prompt unchanged, after only
  Claude Code's billing header and a one-line identity. Claude Code's own prompt,
  project instructions, skills and environment details are left out.
- **pi's tools.** The model sees pi's tools under their own names, and pi runs them.
  Claude Code's built-in tools and MCP servers stay off.
- **pi's session.** pi keeps the conversation, compaction, retries and thinking
  level. The requests of a pi session share one Claude Code session ID, but Claude
  Code stores nothing.
- **pi's prompt caching.** The conversation, tools, thinking settings and cache
  breakpoints are those of pi's Anthropic provider, so each request reads the earlier
  conversation from cache. On models that support it, a change to the system prompt
  or the tools during a session is sent as a message, which keeps the cached
  conversation valid.
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

## Usage credits

When Claude Code reports that a response was charged to
[usage credits](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans)
instead of your plan's limits, pi stops with an error rather than sending more
requests. This happens once a plan limit is used up while usage credits are turned
on, and on every request with models or modes that always use credits. pi also stops
without retrying when Anthropic refuses to bill a request to your plan's limits.

To stay on your plan's limits, turn off usage credits at
[claude.ai/settings/usage](https://claude.ai/settings/usage). To let pi use them, set
`PI_CLAUDE_CLI_ALLOW_USAGE_CREDITS=1` before starting pi.

## Notes

- Requests are billed to the account `claude` is signed in to, not to pi's `/login`.
  The [`usage`](../usage) plugin reads the limits of `claude-cli` models from that
  account too, so pi needs no Claude sign-in of its own.
- API keys in the environment, such as `ANTHROPIC_API_KEY`, are not passed on to
  Claude Code, so requests always use the subscription.
- Cache retention follows pi's `PI_CACHE_RETENTION` setting. It is five minutes by
  default and one hour with `long`.
- When another Claude Code process is refreshing the login, a request waits and tries
  again for up to a minute.
- Starting Claude Code takes about a quarter of a second, so from its second request
  on, each session keeps one process started ahead for its next request. An idle
  process takes about 200 MiB. It is stopped after five idle minutes and when the
  session ends.
