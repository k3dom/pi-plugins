# `@pi-plugins/claude-oauth`

Compatibility fixes for using a Claude subscription in
[pi](https://github.com/earendil-works/pi).

## Install

```bash
pi install npm:@pi-plugins/claude-oauth
```

To try it for one session without changing your settings:

```bash
pi -e npm:@pi-plugins/claude-oauth
```

## Usage

Sign in to Anthropic with `/login`, then select a Claude model from the built-in
`anthropic` provider. The plugin works automatically, with no additional provider or
configuration.

## Cache retention

The plugin never changes the cache markers pi emits. Retention follows pi's
`PI_CACHE_RETENTION` setting. The one-hour TTL survives longer breaks but writes to
the cache at a higher rate, and that rate counts against subscription usage too.
Claude Code itself uses one hour for the main conversation while within plan usage
and five minutes for subagents and once on usage credits. Recommendation: set
`PI_CACHE_RETENTION=long` for interactive sessions (subagents stay `short` via
`@pi-plugins/subagent`), and leave it unset when you are on usage credits.

This plugin is for subscription sign-ins, not API-key access.
