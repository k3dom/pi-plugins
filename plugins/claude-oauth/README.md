# `@pi-plugins/claude-oauth`

<!-- prettier-ignore -->
> [!WARNING]
> This package is deprecated. Use
> [`@pi-plugins/claude-cli`](https://github.com/k3dom/pi-plugins/tree/master/plugins/claude-cli)
> instead. It sends requests through the official Claude Code CLI rather than copying
> Claude Code's headers and request signing, which needed an update for most Claude
> Code releases.
>
> To switch, sign in with `claude auth login`, replace the package and pick a model
> from the `claude-cli` provider, such as `claude-cli/claude-sonnet-5-5`:
>
> ```bash
> pi remove npm:@pi-plugins/claude-oauth
> pi install npm:@pi-plugins/claude-cli
> ```

Compatibility fixes for using a Claude subscription in
[pi](https://github.com/earendil-works/pi). This plugin is for subscription sign-ins,
not API-key access.

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
